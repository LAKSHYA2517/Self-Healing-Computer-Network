"""Flask app: serves the dashboard and JSON API."""
from flask import Flask, jsonify, request

import failure
import monitor
from state import State
from topology import load_topology

app = Flask(__name__, static_folder="static", static_url_path="")
topology = load_topology()
state = State(topology)

ACTIONS = {
    "fail": {"link": failure.fail_link, "node": failure.fail_node},
    "restore": {"link": failure.restore_link, "node": failure.restore_node},
}


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
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or body.get("type") not in ("link", "node") \
            or not isinstance(body.get("id"), str):
        return jsonify(error='body must be {"type": "link"|"node", "id": "<id>"}'), 400
    try:
        ACTIONS[action][body["type"]](state, body["id"])
    except KeyError as e:
        return jsonify(error=e.args[0]), 400
    return jsonify(state.snapshot())


@app.post("/api/fail")
def api_fail():
    return _apply("fail")


@app.post("/api/restore")
def api_restore():
    return _apply("restore")


@app.post("/api/reset")
def api_reset():
    failure.reset(state)
    return jsonify(state.snapshot())


if __name__ == "__main__":
    monitor.start(state)
    app.run(host="127.0.0.1", port=4000, debug=False)
