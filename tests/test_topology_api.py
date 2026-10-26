import json

import pytest

import app as app_module
import topology_store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(topology_store, "TOPO_DIR", str(tmp_path))
    sim = app_module.sim
    sim.noise = False
    sim.pause()
    sim.reset_topology()
    sim.reset()
    sim._undo.clear(), sim._redo.clear()
    yield app_module.app.test_client()
    sim.reset_topology()
    sim.reset()
    sim.resume()
    sim._undo.clear(), sim._redo.clear()


def ok(r, code=200):
    assert r.status_code == code, r.get_json()
    return r.get_json()


def test_get_topology_has_editor_metadata(client):
    t = ok(client.get("/api/topology"))
    assert len(t["nodes"]) == 10 and len(t["links"]) == 15
    assert (t["name"], t["dirty"], t["warnings"], t["can_undo"], t["can_redo"]) == ("default", False, [], False, False)
    assert t["limits"]["max_nodes"] == 30 and t["limits"]["latency"] == [1, 500]
    assert (t["next_node"], t["next_link"]) == (11, 16) and "version" in t


def test_mutations_return_topology_snapshot_and_impact(client):
    r = ok(client.post("/api/topology/node", json={"x": 600, "y": 60}))
    assert set(r) == {"topology", "snapshot", "impact"}
    assert r["impact"]["kind"] == "node_added" and r["impact"]["id"] == "R11"
    assert any(n["id"] == "R11" for n in r["topology"]["nodes"]) and r["topology"]["dirty"] is True
    assert r["snapshot"]["topology_dirty"] is True and r["snapshot"]["static_path_valid"] is True
    assert set(r["impact"]) >= {"kind", "tick", "summary", "preferred_before", "preferred_after", "healing",
                                "static", "warnings", "message"}
    assert r["impact"]["warnings"] == ["R11 has no links"]


def test_full_edit_flow_through_the_api(client):
    ok(client.post("/api/topology/node", json={"x": 600, "y": 60}))
    ok(client.post("/api/topology/link", json={"a": "R7", "b": "R11", "latency": 3, "bw": 100}))
    r = ok(client.post("/api/topology/link", json={"a": "R11", "b": "R10", "latency": 4}))
    assert r["impact"]["healing"] == "rerouted" and r["impact"]["preferred_after"]["cost"] == 27
    assert r["snapshot"]["healing_path"]["nodes"] == ["R1", "R2", "R5", "R7", "R11", "R10"]
    assert r["snapshot"]["static_path"]["cost"] == 33
    v0 = r["snapshot"]["topology_version"]
    r = ok(client.patch("/api/topology/link/L17", json={"latency": 40}))
    assert r["impact"]["kind"] == "link_updated" and r["snapshot"]["topology_version"] > v0
    r = ok(client.patch("/api/topology/node/R11", json={"x": 650, "y": 70}))
    assert r["impact"]["kind"] == "node_moved"
    assert next(n for n in r["topology"]["nodes"] if n["id"] == "R11")["x"] == 650
    r = ok(client.delete("/api/topology/link/L8"))
    assert r["impact"]["static"] == "broken" and r["snapshot"]["static_path_valid"] is False
    r = ok(client.post("/api/topology/repin-static"))
    assert r["snapshot"]["static_path_valid"] is True and r["impact"]["kind"] == "repin"
    r = ok(client.delete("/api/topology/node/R5"))
    assert sorted(r["impact"]["removed_links"]) == ["L4", "L5", "L9"]


def test_validation_errors_are_400_with_field(client):
    for url, body, field in [
        ("/api/topology/node", {"x": -5, "y": 10}, "x"),
        ("/api/topology/link", {"a": "R5", "b": "R7", "latency": 3}, "b"),
        ("/api/topology/link", {"a": "R1", "b": "R10", "latency": 0}, "latency"),
        ("/api/topology/link", {"a": "R1", "b": "R1", "latency": 3}, "b"),
        ("/api/topology/endpoints", {"source": "R1", "destination": "R1"}, "destination"),
    ]:
        r = client.post(url, json=body)
        assert r.status_code == 400 and r.get_json()["field"] == field and r.get_json()["error"], (url, body)
    r = client.delete("/api/topology/node/R1")
    assert r.status_code == 400 and "R1 is the source" in r.get_json()["error"]
    assert client.post("/api/topology/node", data="nope").status_code == 400
    assert ok(client.get("/api/topology"))["dirty"] is False             # nothing changed


def test_unknown_ids_are_404(client):
    assert client.delete("/api/topology/link/L99").status_code == 404
    assert client.patch("/api/topology/link/L99", json={"latency": 5}).status_code == 404
    assert client.delete("/api/topology/node/R99").status_code == 404
    assert client.patch("/api/topology/node/R99", json={"x": 1, "y": 1}).status_code == 404
    assert client.post("/api/topologies/load", json={"name": "nothing_here"}).status_code == 404


def test_undo_redo_endpoints(client):
    assert client.post("/api/topology/undo").status_code == 400
    ok(client.post("/api/topology/node", json={"x": 5, "y": 5}))
    r = ok(client.post("/api/topology/undo"))
    assert r["impact"]["kind"] == "undo" and r["topology"]["can_redo"] and not r["topology"]["can_undo"]
    assert len(r["topology"]["nodes"]) == 10
    r = ok(client.post("/api/topology/redo"))
    assert len(r["topology"]["nodes"]) == 11 and r["impact"]["kind"] == "redo"
    assert client.post("/api/topology/redo").status_code == 400


def test_endpoints_and_reset(client):
    r = ok(client.post("/api/topology/endpoints", json={"source": "R1", "destination": "R9"}))
    assert r["topology"]["destination"] == "R9" and r["snapshot"]["static_path"]["nodes"][-1] == "R9"
    r = ok(client.post("/api/topology/reset"))
    assert r["topology"]["destination"] == "R10" and r["topology"]["dirty"] is False


def test_save_load_list_export_import(client):
    ok(client.post("/api/topology/node", json={"x": 5, "y": 5}))
    r = ok(client.post("/api/topologies/save", json={"name": "demo1"}))
    assert r["topology"]["name"] == "demo1" and r["topology"]["dirty"] is False
    names = {t["name"]: t["kind"] for t in ok(client.get("/api/topologies"))}
    assert names["demo1"] == "saved" and names["small_ring"] == "preset" and names["default"] == "default"
    assert client.post("/api/topologies/save", json={"name": "../x"}).status_code == 400
    assert client.post("/api/topologies/save", json={"name": "small_ring"}).status_code == 400
    r = ok(client.post("/api/topologies/load", json={"name": "grid_3x3"}))
    assert len(r["topology"]["nodes"]) == 9 and r["snapshot"]["tick"] == 0
    r = ok(client.post("/api/topologies/load", json={"name": "demo1"}))
    assert len(r["topology"]["nodes"]) == 11
    exp = client.get("/api/topology/export")
    assert exp.status_code == 200 and "attachment" in exp.headers["Content-Disposition"]
    data = json.loads(exp.data)
    assert len(data["nodes"]) == 11 and data["next_node"] == 12
    ok(client.post("/api/topology/reset"))
    r = ok(client.post("/api/topology/import", data=exp.data, content_type="application/json"))
    assert len(r["topology"]["nodes"]) == 11 and r["topology"]["dirty"] is True
    assert client.post("/api/topology/import", data="[]").status_code == 400
    bad = {**data, "links": data["links"] + [data["links"][0]]}
    assert client.post("/api/topology/import", json=bad).status_code == 400


def test_preview_is_a_dry_run(client):
    r = ok(client.post("/api/topology/preview", json={"op": "add_link", "a": "R1", "b": "R10", "latency": 20}))
    assert r["impact"]["healing"] == "rerouted" and r["impact"]["preview"] is True
    assert ok(client.get("/api/topology"))["dirty"] is False and len(ok(client.get("/api/topology"))["links"]) == 15
    assert client.post("/api/topology/preview", json={"op": "nope"}).status_code == 400


def test_state_has_new_fields(client):
    s = ok(client.get("/api/state"))
    assert {"topology_version", "topology_dirty", "static_path_valid"} <= set(s)
    assert s["scenario"]["edited"] is False


def test_scenario_start_409_when_topology_would_be_replaced(client, tmp_path, monkeypatch):
    sc = {"name": "tmp_ring_sc", "duration": 5, "topology": "small_ring", "events": []}
    import simulation
    d = tmp_path / "scenarios"
    d.mkdir()
    (d / "tmp_ring_sc.json").write_text(json.dumps(sc))
    monkeypatch.setattr(simulation, "SCENARIO_DIR", str(d))
    ok(client.post("/api/topology/node", json={"x": 5, "y": 5}))
    r = client.post("/api/scenario/start", json={"name": "tmp_ring_sc"})
    assert r.status_code == 409 and r.get_json() == {"error": "topology_dirty", "needs": "small_ring"}
    assert len(ok(client.get("/api/topology"))["nodes"]) == 11
    r = ok(client.post("/api/scenario/start", json={"name": "tmp_ring_sc", "confirm": True}))
    assert r["scenario"]["running"] and ok(client.get("/api/topology"))["name"] == "small_ring"
    listing = ok(client.get("/api/scenarios"))
    assert all(sc["topology"] == "default" and "runnable" in sc for sc in listing)


def test_scenarios_flag_unrunnable_after_edit(client):
    ok(client.delete("/api/topology/link/L8"))
    sc = {s["name"]: s for s in ok(client.get("/api/scenarios"))}
    assert sc["link_failure"]["runnable"] is False and "L8" in sc["link_failure"]["problem"]
    assert sc["node_failure"]["runnable"] is True
    r = client.post("/api/scenario/start", json={"name": "link_failure"})
    assert r.status_code == 400 and "unknown id" in r.get_json()["error"]
