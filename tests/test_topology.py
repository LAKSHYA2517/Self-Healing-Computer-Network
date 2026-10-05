import json

import pytest

from topology import load_topology, to_networkx


def test_loads_expected_size_and_connected():
    t = load_topology()
    assert len(t.nodes) == 10 and len(t.links) == 15
    assert (t.source, t.destination) == ("R1", "R10")
    assert to_networkx(t).number_of_edges() == 15


def test_exclusions():
    g = to_networkx(load_topology(), exclude_links={"L1"}, exclude_nodes={"R5"})
    assert "R5" not in g and not g.has_edge("R1", "R2")


@pytest.mark.parametrize("mutate", [
    lambda d: d["links"].append(dict(d["links"][0])),                    # duplicate link id
    lambda d: d["links"].__setitem__(0, {**d["links"][0], "b": "R99"}),  # unknown node
    lambda d: d["links"].__delitem__(slice(0, 2)),                       # R1 isolated
    lambda d: d.pop("source"),
])
def test_invalid_raises(tmp_path, mutate):
    d = json.load(open("topology.json"))
    mutate(d)
    p = tmp_path / "t.json"
    p.write_text(json.dumps(d))
    with pytest.raises(ValueError):
        load_topology(str(p))


def test_missing_or_garbage_file(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("not json")
    for path in (str(p), str(tmp_path / "nope.json")):
        with pytest.raises(ValueError):
            load_topology(path)
