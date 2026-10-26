import json
import pathlib

import networkx as nx
import pytest

import topology_store
from topology import (TopologyError, UnknownElement, add_link, add_node, default_latency, diff_topologies,
                      load_topology, move_node, remove_link, remove_node, set_endpoints, to_networkx,
                      topology_from_dict, update_link, warnings)

FIXTURE = pathlib.Path(__file__).parent.parent / "frontend/src/test/fixtures/default_latency.json"


@pytest.fixture
def t():
    return load_topology()


def test_ids_continue_from_counters(t):
    assert (t.next_node, t.next_link) == (11, 16)
    t2 = add_node(t, 600, 60)
    assert "R11" in t2.nodes and t2.next_node == 12 and t2.version == t.version + 1
    t3 = add_link(t2, "R7", "R11", 3)
    t4 = add_link(t3, "R11", "R10", 4)
    assert [l for l in t4.links if l in ("L16", "L17")] == ["L16", "L17"]
    assert t4.links["L16"].bw == 100


def test_models_are_immutable(t):
    with pytest.raises(TypeError):
        t.nodes["R99"] = None
    with pytest.raises(Exception):
        t.source = "R2"
    assert "R11" not in t.nodes and len(add_node(t, 1, 1).nodes) == 11 and len(t.nodes) == 10


@pytest.mark.parametrize("call,field", [
    (lambda t: add_node(t, -1, 10), "x"),
    (lambda t: add_node(t, 10, 601), "y"),
    (lambda t: add_node(t, "a", 10), "x"),
    (lambda t: add_link(t, "R5", "R7", 3), "b"),            # duplicate pair
    (lambda t: add_link(t, "R7", "R5", 3), "b"),            # duplicate pair, other direction
    (lambda t: add_link(t, "R1", "R1", 3), "b"),            # self loop
    (lambda t: add_link(t, "R1", "R99", 3), "b"),           # unknown router
    (lambda t: add_link(t, "R1", "R10", 0), "latency"),
    (lambda t: add_link(t, "R1", "R10", 501), "latency"),
    (lambda t: add_link(t, "R1", "R10", 5, 0), "bw"),
    (lambda t: add_link(t, "R1", "R10", 5, 10001), "bw"),
    (lambda t: add_link(t, "R1", "R10", True), "latency"),
    (lambda t: update_link(t, "L1", latency=-5), "latency"),
    (lambda t: update_link(t, "L99", latency=5), "id"),
    (lambda t: remove_node(t, "R1"), "id"),
    (lambda t: remove_node(t, "R10"), "id"),
    (lambda t: set_endpoints(t, "R1", "R1"), "destination"),
    (lambda t: set_endpoints(t, "R1", "R99"), "destination"),
])
def test_validation_errors_name_the_field(t, call, field):
    with pytest.raises(TopologyError) as e:
        call(t)
    assert e.value.field == field and str(e.value)


def test_error_messages_are_human(t):
    with pytest.raises(TopologyError, match="L8 already connects R5 and R7"):
        add_link(t, "R5", "R7", 3)
    with pytest.raises(TopologyError, match="R1 is the source. Choose another source first"):
        remove_node(t, "R1")
    with pytest.raises(UnknownElement):
        remove_link(t, "L99")


def test_limits(t):
    big = t
    while len(big.nodes) < 30:
        big = add_node(big, 10, 10)
    with pytest.raises(TopologyError, match="at most 30"):
        add_node(big, 1, 1)
    chain = big
    ids = list(chain.nodes)
    pairs = [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]
             if not any({l.a, l.b} == {a, b} for l in chain.links.values())]
    for a, b in pairs[: 80 - len(chain.links)]:
        chain = add_link(chain, a, b, 5)
    assert len(chain.links) == 80
    a, b = pairs[80 - 15]
    with pytest.raises(TopologyError, match="at most 80"):
        add_link(chain, a, b, 5)


def test_cascade_removal_lists_links(t):
    new, gone = remove_node(t, "R5")
    assert sorted(gone) == ["L4", "L5", "L8", "L9"]
    assert "R5" not in new.nodes and not any("R5" in (l.a, l.b) for l in new.links.values())
    assert diff_topologies(t, new).removed_nodes == ("R5",)


def test_move_only_bumps_layout_version(t):
    moved = move_node(t, "R3", 10, 20)
    assert (moved.version, moved.layout_version) == (t.version, t.layout_version + 1)
    assert not diff_topologies(t, moved).structural and diff_topologies(t, moved).moved_nodes == ("R3",)


def test_ids_never_reused_after_removal(t):
    t2 = remove_link(t, "L8")
    t3 = add_link(t2, "R5", "R7", 5)
    assert "L16" in t3.links and "L8" not in t3.links


def test_warnings_are_not_errors(t):
    t2 = add_node(t, 5, 5)
    assert warnings(t2) == ["R11 has no links"]
    cut = remove_link(remove_link(t, "L1"), "L2")
    assert "No route from R1 to R10" in warnings(cut) and "R1 has no links" in warnings(cut)
    assert warnings(t) == []


def test_default_latency_matches_shared_fixture():
    for c in json.loads(FIXTURE.read_text()):
        assert default_latency(c["a"], c["b"]) == c["expected"], c


def test_export_import_roundtrip(t):
    t2 = add_link(add_node(t, 600, 60), "R7", "R11", 3)
    back = topology_store.import_json(topology_store.export_json(t2))
    assert back.nodes == t2.nodes and back.links == t2.links
    assert (back.source, back.destination, back.next_node, back.next_link) == (
        t2.source, t2.destination, t2.next_node, t2.next_link)


def test_import_allows_disconnected_but_rejects_bad_structure(t):
    d = topology_store.export_json(add_node(t, 5, 5))
    assert "R11" in topology_store.import_json(d).nodes            # isolated router is fine
    for mutate in (lambda x: x["links"].append(dict(x["links"][0])),
                   lambda x: x["links"].__setitem__(0, {**x["links"][0], "b": "R99"}),
                   lambda x: x["links"].__setitem__(0, {**x["links"][0], "latency": 9999}),
                   lambda x: x.pop("nodes")):
        raw = json.loads(d)
        mutate(raw)
        with pytest.raises(TopologyError):
            topology_store.import_json(json.dumps(raw))
    with pytest.raises(TopologyError):
        topology_store.import_json("not json")


def test_counters_in_files_never_fall_below_existing_ids(t):
    raw = t.to_dict()
    raw["next_node"], raw["next_link"] = 2, 2
    t2 = topology_from_dict(raw)
    assert (t2.next_node, t2.next_link) == (11, 16)
    raw.pop("next_node"), raw.pop("next_link")
    assert topology_from_dict(raw).next_link == 16


@pytest.mark.parametrize("name", ["small_ring", "grid_3x3"])
def test_presets_are_valid_and_have_two_disjoint_paths(name):
    p = topology_store.load(name)
    assert nx.edge_connectivity(to_networkx(p), p.source, p.destination) >= 2
    for n in p.nodes.values():
        assert 0 <= n.x <= 900 and 0 <= n.y <= 500
    assert all(3 <= l.latency <= 15 for l in p.links.values())
    assert len(p.nodes) == {"small_ring": 6, "grid_3x3": 9}[name]
    assert not warnings(p)


@pytest.mark.parametrize("bad", ["../x", "a/b", "", "x" * 41, "a.b", "..", "a b"])
def test_names_are_sanitised(t, bad):
    with pytest.raises(TopologyError):
        topology_store.check_name(bad)
    with pytest.raises(TopologyError):
        topology_store.save(bad, t)


def test_reserved_names_cannot_be_overwritten(t):
    for name in ("default", "small_ring", "grid_3x3", "_autosave"):
        with pytest.raises(TopologyError):
            topology_store.save(name, t)


def test_save_load_list_roundtrip(tmp_path, monkeypatch, t):
    monkeypatch.setattr(topology_store, "TOPO_DIR", str(tmp_path))
    t2 = add_node(t, 100, 100)
    topology_store.save("my_net", t2)
    assert {"name": "my_net", "kind": "saved"} in topology_store.list_topologies()
    back = topology_store.load("my_net")
    assert "R11" in back.nodes and back.name == "my_net"
    with pytest.raises(KeyError):
        topology_store.load("nothing_here")
