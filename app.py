"""Flask app: serves the dashboard and JSON API."""
import os
import re

from flask import Flask, Response, jsonify, redirect, request, send_from_directory

import failure
import metrics
from simulation import Simulation, list_scenarios
from topology import load_topology

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "frontend", "dist")
LEGACY = os.path.join(ROOT, "static")

app = Flask(__name__, static_folder=None)
topology = load_topology()
sim = Simulation(topology)
state = sim.state

ACTIONS = {
    "fail": {"link": failure.fail_link, "node": failure.fail_node},
    "restore": {"link": failure.restore_link, "node": failure.restore_node},
}


def _body() -> dict:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ValueError("JSON object body required")
    return body


def _num(body: dict, key: str, default=None) -> float:
    v = body.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{key} must be a number")
    return v


def _link_id(body: dict) -> str:
    if not isinstance(body.get("id"), str):
        raise ValueError("id must be a string")
    return body["id"]


def _mutate(fn):
    """Run a state mutation and return the new snapshot, or 400 with {"error": ...}."""
    try:
        fn()
    except KeyError as e:
        return jsonify(error=e.args[0]), 400
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(state.snapshot())


@app.get("/legacy")
def legacy_redirect():
    return redirect("/legacy/")


@app.get("/legacy/")
def legacy_index():
    return send_from_directory(LEGACY, "index.html")


@app.get("/legacy/<path:name>")
def legacy_file(name: str):
    return send_from_directory(LEGACY, name)


@app.get("/results/<path:name>")
def results_file(name: str):
    return send_from_directory(os.path.join(ROOT, "results"), name)


@app.get("/")
@app.get("/<path:name>")
def frontend(name: str = "index.html"):
    """React build from frontend/dist; falls back to the legacy page if it is not built."""
    if name.startswith("api/"):
        return jsonify(error="unknown endpoint"), 404
    root = DIST if os.path.isfile(os.path.join(DIST, "index.html")) else LEGACY
    if not os.path.isfile(os.path.join(root, name)):
        name = "index.html"
    return send_from_directory(root, name)


@app.get("/api/topology")
def api_topology():
    return jsonify(topology.to_dict())


@app.get("/api/state")
def api_state():
    return jsonify(state.snapshot())


def _apply(action: str):
    def run():
        body = _body()
        if body.get("type") not in ("link", "node"):
            raise ValueError('body must be {"type": "link"|"node", "id": "<id>"}')
        ACTIONS[action][body["type"]](state, _link_id(body))
    return _mutate(run)


@app.post("/api/fail")
def api_fail():
    return _apply("fail")


@app.post("/api/restore")
def api_restore():
    return _apply("restore")


@app.post("/api/reset")
def api_reset():
    return _mutate(sim.reset)


@app.post("/api/degrade")
def api_degrade():
    def run():
        b = _body()
        failure.degrade_link(state, _link_id(b), _num(b, "loss_pct"), _num(b, "latency_mult", 1.0))
    return _mutate(run)


@app.post("/api/congest")
def api_congest():
    def run():
        b = _body()
        failure.congest_link(state, _link_id(b), _num(b, "util_pct"))
    return _mutate(run)


@app.post("/api/clear")
def api_clear():
    return _mutate(lambda: failure.clear_link(state, _link_id(_body())))


@app.get("/api/scenarios")
def api_scenarios():
    return jsonify(list_scenarios())


@app.post("/api/pause")
def api_pause():
    return _mutate(sim.pause)


@app.post("/api/resume")
def api_resume():
    return _mutate(sim.resume)


@app.post("/api/step")
def api_step():
    return _mutate(sim.step_once)


@app.post("/api/speed")
def api_speed():
    return _mutate(lambda: sim.set_speed(_num(_body(), "tick_seconds")))


@app.post("/api/scenario/start")
def api_scenario_start():
    def run():
        name = _body().get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[\w-]+", name):
            raise ValueError("name must be a scenario name")
        sim.start_scenario(name)
    return _mutate(run)


@app.post("/api/scenario/stop")
def api_scenario_stop():
    return _mutate(sim.stop_scenario)


@app.get("/api/summary")
def api_summary():
    return jsonify(sim.summary())


@app.get("/api/export")
def api_export():
    with state.lock:
        text = metrics.rows_to_csv(list(state.rows))
    return Response(text, mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=ticks.csv"})


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Self-healing network dashboard")
    ap.add_argument("--no-noise", action="store_true",
                    help="exact metrics (no jitter) so results match scenario_runner.py")
    sim.noise = not ap.parse_args().no_noise
    sim.start()
    app.run(host="127.0.0.1", port=3000, debug=False)
