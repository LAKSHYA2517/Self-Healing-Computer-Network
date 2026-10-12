"""Flask app: serves the dashboard and JSON API."""
import re

from flask import Flask, Response, jsonify, request

import failure
import metrics
from simulation import Simulation, list_scenarios
from topology import load_topology

app = Flask(__name__, static_folder="static", static_url_path="")
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


@app.get("/")
def index():
    return app.send_static_file("index.html")


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
    sim.start()
    app.run(host="127.0.0.1", port=4000, debug=False)
