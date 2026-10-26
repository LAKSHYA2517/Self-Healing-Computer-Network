"""Flask app: serves the dashboard and JSON API."""
import os
import re

from flask import Flask, Response, jsonify, redirect, request, send_from_directory

import failure
import metrics
import topology_store
from simulation import Simulation, TopologyDirty
from topology import TopologyError, UnknownElement, load_topology

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "frontend", "dist")
LEGACY = os.path.join(ROOT, "static")

app = Flask(__name__, static_folder=None)
sim = Simulation(load_topology(topology_store.DEFAULT_FILE))
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


def _topo(fn, extra=None):
    """Run a topology edit; reply {topology, snapshot, impact} or an error (400, 404)."""
    try:
        impact = fn()
    except UnknownElement as e:
        return jsonify(error=str(e), field=e.field), 404
    except TopologyError as e:
        return jsonify(error=str(e), field=e.field), 400
    except KeyError as e:
        return jsonify(error=e.args[0]), 404
    except ValueError as e:
        return jsonify(error=str(e), field=None), 400
    return jsonify(topology=sim.topology_payload(), snapshot=state.snapshot(), impact=impact)


@app.get("/api/topology")
def api_topology():
    return jsonify(sim.topology_payload())


@app.post("/api/topology/node")
def api_node_add():
    return _topo(lambda: sim.edit("add_node", _body()))


@app.patch("/api/topology/node/<node_id>")
def api_node_move(node_id: str):
    return _topo(lambda: sim.edit("move_node", {**_body(), "id": node_id}))


@app.delete("/api/topology/node/<node_id>")
def api_node_delete(node_id: str):
    return _topo(lambda: sim.edit("remove_node", {"id": node_id}))


@app.post("/api/topology/link")
def api_link_add():
    return _topo(lambda: sim.edit("add_link", _body()))


@app.patch("/api/topology/link/<link_id>")
def api_link_update(link_id: str):
    return _topo(lambda: sim.edit("update_link", {**_body(), "id": link_id}))


@app.delete("/api/topology/link/<link_id>")
def api_link_delete(link_id: str):
    return _topo(lambda: sim.edit("remove_link", {"id": link_id}))


@app.post("/api/topology/endpoints")
def api_endpoints():
    return _topo(lambda: sim.edit("set_endpoints", _body()))


@app.post("/api/topology/repin-static")
def api_repin():
    return _topo(sim.repin_static)


@app.post("/api/topology/undo")
def api_undo():
    return _topo(sim.undo)


@app.post("/api/topology/redo")
def api_redo():
    return _topo(sim.redo)


@app.post("/api/topology/reset")
def api_topology_reset():
    return _topo(sim.reset_topology)


@app.post("/api/topology/preview")
def api_preview():
    def run():
        body = _body()
        return sim.preview(body.get("op"), body)
    try:
        impact = run()
    except UnknownElement as e:
        return jsonify(error=str(e), field=e.field), 404
    except ValueError as e:
        return jsonify(error=str(e), field=getattr(e, "field", None)), 400
    return jsonify(impact=impact)


@app.get("/api/topology/export")
def api_topology_export():
    return Response(topology_store.export_json(sim.topology), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename={sim.topology.name}.json"})


@app.post("/api/topology/import")
def api_topology_import():
    return _topo(lambda: sim.import_topology(request.get_data(as_text=True)))


@app.get("/api/topologies")
def api_topologies():
    return jsonify(topology_store.list_topologies())


def _saved(name):
    sim.save_as(name)
    return {"kind": "save", "message": f"Saved topology '{name}'.", "summary": f"Saved '{name}'"}


@app.post("/api/topologies/save")
def api_topologies_save():
    return _topo(lambda: _saved(_body().get("name")))


@app.post("/api/topologies/load")
def api_topologies_load():
    return _topo(lambda: sim.load_by_name(_body().get("name")))


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
    return jsonify(sim.scenarios())


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
        body = _body()
        name = body.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[\w-]+", name):
            raise ValueError("name must be a scenario name")
        sim.start_scenario(name, confirm=body.get("confirm") is True)
    try:
        return _mutate(run)
    except TopologyDirty as e:
        return jsonify(error="topology_dirty", needs=e.args[0]), 409


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
