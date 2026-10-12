import json

import pytest

import app as app_module
from simulation import list_scenarios


@pytest.fixture
def client():
    sim = app_module.sim
    sim.reset()
    sim.pause()
    sim.set_speed(1.0)
    yield app_module.app.test_client()
    sim.resume()
    sim.reset()


def post(c, path, body=None):
    return c.post(path, json=body or {})


def test_pause_resume_step_speed(client):
    s = client.get("/api/state").get_json()
    assert s["paused"] is True and s["tick_seconds"] == 1.0
    t = s["tick"]
    assert post(client, "/api/step").get_json()["tick"] == t + 1
    assert post(client, "/api/speed", {"tick_seconds": 0.5}).get_json()["tick_seconds"] == 0.5
    assert post(client, "/api/speed", {"tick_seconds": 0.1}).status_code == 400
    assert post(client, "/api/speed", {"tick_seconds": 5}).status_code == 400
    assert post(client, "/api/speed", {"tick_seconds": "x"}).status_code == 400
    assert post(client, "/api/resume").get_json()["paused"] is False
    r = post(client, "/api/step")
    assert r.status_code == 400 and "paused" in r.get_json()["error"]
    assert post(client, "/api/pause").get_json()["paused"] is True


def test_event_kinds_and_fault_log(client):
    post(client, "/api/scenario/start", {"name": "link_failure"})
    for _ in range(46):
        post(client, "/api/step")
    s = client.get("/api/state").get_json()
    kinds = [(e["tick"], e["kind"]) for e in s["events"]]
    assert (10, "fault") in kinds and (11, "detect") in kinds and (11, "reroute") in kinds
    assert (40, "restore") in kinds and (44, "failback") in kinds
    assert all("kind" in e and "tick" in e for e in s["events"])
    f = s["fault_log"][0]
    assert {k: f[k] for k in ("tick", "op", "target", "restored_tick")} == {
        "tick": 10, "op": "fail_link", "target": "L8", "restored_tick": 40}


def test_detector_progress_counts_up(client):
    post(client, "/api/fail", {"type": "link", "id": "L8"})
    p = post(client, "/api/step").get_json()["detector_progress"]["L8"]
    assert p == {"pending": "down", "count": 1, "needed": 2}
    p = post(client, "/api/step").get_json()["detector_progress"]["L8"]
    assert p["pending"] is None                       # confirmed down
    post(client, "/api/restore", {"type": "link", "id": "L8"})
    p = post(client, "/api/step").get_json()["detector_progress"]["L8"]
    assert p == {"pending": "recover", "count": 1, "needed": 5}
    assert client.get("/api/state").get_json()["fault_log"][0]["restored_tick"] == 2


def test_impairment_fault_log_closed_by_clear(client):
    post(client, "/api/degrade", {"id": "L8", "loss_pct": 25})
    post(client, "/api/congest", {"id": "L4", "util_pct": 95})
    post(client, "/api/clear", {"id": "L8"})
    log = {f["target"]: f for f in client.get("/api/state").get_json()["fault_log"]}
    assert log["L8"]["op"] == "degrade_link" and log["L8"]["restored_tick"] == 0
    assert log["L4"]["op"] == "congest_link" and log["L4"]["restored_tick"] is None


def test_scenarios_include_planned_events(client):
    sc = {s["name"]: s for s in client.get("/api/scenarios").get_json()}
    assert sc["link_failure"]["events"][0] == {"t": 10, "op": "fail_link", "id": "L8"}
    assert len(sc["link_failure"]["events"]) == 2
    assert [s["name"] for s in list_scenarios()] == sorted(sc)


def test_legacy_and_frontend_routes(client):
    assert client.get("/legacy/").status_code == 200
    assert b"app.js" in client.get("/legacy/").data
    assert client.get("/legacy/style.css").status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/api/nope").status_code == 404


def test_dump_snapshots(tmp_path, monkeypatch):
    import scenario_runner
    out = tmp_path / "rec.json"
    monkeypatch.setattr("sys.argv", ["scenario_runner.py", "scenarios/link_failure.json",
                                     "--dump-snapshots", str(out)])
    scenario_runner.main()
    rec = json.loads(out.read_text())
    assert len(rec["snapshots"]) == 60 and rec["topology"]["source"] == "R1"
    assert [s["tick"] for s in rec["snapshots"]] == list(range(1, 61))
    assert rec["snapshots"][59]["kpis"]["static"]["lost_packets"] == 3000
    assert rec["summary"]["static"]["lost"] == 3000 and rec["summary"]["healing"]["lost"] == 200
