import threading

import pytest

import failure
import topology_store
from simulation import Simulation, TopologyDirty
from topology import TopologyError, load_topology

BASE = ["R1", "R2", "R5", "R7", "R9", "R10"]
VIA_R4 = ["R1", "R2", "R4", "R7", "R9", "R10"]


@pytest.fixture
def sim():
    return Simulation(load_topology(), noise=False, log=False)


def run(sim, n):
    for _ in range(n):
        sim.step()


def run_to(sim, tick):
    run(sim, tick - sim.state.tick)


def last(sim, flow):
    return sim.state.series[flow][-1]


def e1(sim):
    """E1: add R11, then R7-R11 (3 ms) and R11-R10 (4 ms). Returns the three impacts."""
    a = sim.edit("add_node", {"x": 600, "y": 60})
    b = sim.edit("add_link", {"a": "R7", "b": "R11", "latency": 3})
    c = sim.edit("add_link", {"a": "R11", "b": "R10", "latency": 4})
    return a, b, c


# ------------------------------------------------------------------ section 7 reference table

def test_e1_new_cheaper_route(sim):
    run_to(sim, 10)
    a, b, c = e1(sim)
    assert a["id"] == "R11" and b["id"] == "L16" and c["id"] == "L17"
    assert a["healing"] == b["healing"] == "unchanged"
    assert b["preferred_after"] == {"nodes": BASE, "cost": 33}
    assert c["preferred_after"] == {"nodes": ["R1", "R2", "R5", "R7", "R11", "R10"], "cost": 27}
    assert c["healing"] == "rerouted" and c["static"] == "unchanged"
    assert c["message"] == ("Added link L17 (R11-R10). Self-healing switched to R1>R2>R5>R7>R11>R10 "
                            "(cost 27, was 33). Static routing keeps its manual route.")
    run(sim, 1)
    assert last(sim, "healing")["delay_ms"] == 27 and last(sim, "static")["delay_ms"] == 33
    assert sim.state.static_path.nodes == BASE and sim.state.static_valid()
    assert last(sim, "healing")["lost_packets"] == 0


def test_e1_then_fault_reroutes_after_two_ticks(sim):
    run_to(sim, 10)
    e1(sim)
    run_to(sim, 20)
    failure.fail_link(sim.state, "L8")
    run_to(sim, 26)
    first = [c for c in sim.state.route_changes if c["tick"] >= 20][0]
    assert first["to"] == "R1-R2-R4-R7-R11-R10" and first["cost"] == 28 and first["tick"] == 21
    assert first["tick"] - 20 + 1 == 2
    lost = sum(r["lost_packets"] for r in sim.state.series["healing"] if r["tick"] >= 20)
    assert lost == 200


def test_e2_planned_delete_loses_nothing_while_static_breaks(sim):
    run_to(sim, 10)
    imp = sim.edit("remove_link", {"id": "L8"})
    assert imp["preferred_after"] == {"nodes": VIA_R4, "cost": 34}
    assert imp["healing"] == "rerouted" and imp["static"] == "broken"
    assert not sim.state.static_valid()
    run_to(sim, 60)
    s = sim.summary()
    assert s["healing"]["lost"] == 0 and s["healing"]["outage_ticks"] == 0
    assert s["static"]["lost"] == 5000
    assert 60 - s["static"]["outage_ticks"] == 10          # available 10 of 60 ticks


def test_e2_repin_before_tick_30(sim):
    run_to(sim, 10)
    sim.edit("remove_link", {"id": "L8"})
    run_to(sim, 30)
    r = sim.repin_static()
    assert r["static"] == "restored" and sim.state.static_valid()
    assert sim.state.static_path.nodes == VIA_R4
    run_to(sim, 60)
    s = sim.summary()
    assert s["static"]["lost"] == 2000 and 60 - s["static"]["outage_ticks"] == 40
    assert s["healing"]["lost"] == 0


def test_fault_costs_two_ticks_but_planned_removal_costs_none(sim):
    run_to(sim, 10)
    failure.fail_link(sim.state, "L8")
    run_to(sim, 60)
    assert sim.summary()["healing"]["lost"] == 200


def test_e3_direct_link(sim):
    imp = sim.edit("add_link", {"a": "R1", "b": "R10", "latency": 20})
    assert imp["preferred_after"] == {"nodes": ["R1", "R10"], "cost": 20}
    assert imp["healing"] == "rerouted" and imp["static"] == "unchanged"
    run(sim, 1)
    assert last(sim, "healing")["delay_ms"] == 20 and last(sim, "static")["delay_ms"] == 33


def test_e4_delete_router_cascades(sim):
    run_to(sim, 10)
    imp = sim.edit("remove_node", {"id": "R5"})
    assert sorted(imp["removed_links"]) == ["L4", "L5", "L8", "L9"]
    assert imp["preferred_after"] == {"nodes": VIA_R4, "cost": 34}
    assert imp["healing"] == "rerouted" and imp["static"] == "broken"
    run(sim, 1)
    assert last(sim, "healing")["lost_packets"] == 0 and last(sim, "static")["lost_packets"] == 100


def test_e5_shortcut_from_r5(sim):
    imp = sim.edit("add_link", {"a": "R5", "b": "R10", "latency": 12})
    assert imp["preferred_after"] == {"nodes": ["R1", "R2", "R5", "R10"], "cost": 27}
    assert imp["healing"] == "rerouted" and imp["static"] == "unchanged"


def test_e6_slower_link(sim):
    imp = sim.edit("update_link", {"id": "L8", "latency": 20})
    assert imp["preferred_after"] == {"nodes": VIA_R4, "cost": 34}
    assert imp["healing"] == "rerouted" and imp["static"] == "unchanged"
    assert "was 48" in imp["message"]
    run(sim, 1)
    assert last(sim, "static")["delay_ms"] == 48 and last(sim, "healing")["delay_ms"] == 34


def test_e7_no_path(sim):
    run_to(sim, 5)
    sim.edit("remove_link", {"id": "L1"})
    imp = sim.edit("remove_link", {"id": "L2"})
    assert imp["preferred_after"] is None and imp["healing"] == "no_path"
    assert sim.state.healing_path is None
    assert [e["level"] for e in sim.state.events].count("CRITICAL") == 1
    assert "There is no route from R1 to R10" in imp["message"] and imp["warnings"]
    run(sim, 3)
    assert last(sim, "healing")["delivery_pct"] == 0 and last(sim, "static")["delivery_pct"] == 0
    assert [e["level"] for e in sim.state.events].count("CRITICAL") == 1
    sim.undo()                                              # bring L2 back: healing recovers at once
    assert sim.state.healing_path is not None


# ------------------------------------------------------------------ behaviour around the funnel

def test_endpoint_change_resets_counters_and_repins(sim):
    run(sim, 5)
    imp = sim.edit("set_endpoints", {"source": "R1", "destination": "R9"})
    st = sim.state
    assert st.tick == 5 and not st.series["static"] and st.flow_totals["healing"]["ticks"] == 0
    assert st.static_path.nodes == ["R1", "R2", "R5", "R7", "R9"] and st.healing_path.nodes == st.static_path.nodes
    assert any("Flow endpoints changed, counters reset" in e["message"] for e in st.events)
    assert imp["preferred_after"]["nodes"][-1] == "R9"
    run(sim, 2)
    assert last(sim, "static")["delivery_pct"] == 100


def test_cannot_delete_endpoints(sim):
    with pytest.raises(TopologyError, match="R1 is the source"):
        sim.edit("remove_node", {"id": "R1"})
    assert "R1" in sim.topology.nodes


def test_no_stale_state_after_removal(sim):
    st = sim.state
    failure.fail_link(st, "L8")
    failure.degrade_link(st, "L4", 25)
    run(sim, 6)
    sim.edit("remove_node", {"id": "R5"})
    gone = {"L4", "L5", "L8", "L9"}
    for table in (st.link_metrics, st.history, st.impairments, st.link_health, st.ewma,
                  st.detector_progress, sim._util, sim.detector._count, sim.detector._reason):
        assert not gone & set(table), table
    assert not gone & st.failed_links and "R5" not in st.dead_nodes and "R5" not in st.failed_nodes
    assert all(f["restored_tick"] is not None for f in st.fault_log if f["target"] in gone | {"R5"})
    assert st.fault_log and st.route_changes                      # history is kept
    run(sim, 4)
    assert not gone & set(st.link_metrics) and not gone & set(st.link_health)
    with pytest.raises(KeyError):
        failure.fail_link(st, "L8")


def test_new_link_has_no_metrics_until_next_sample_then_healthy(sim):
    sim.edit("add_node", {"x": 600, "y": 60})
    sim.edit("add_link", {"a": "R7", "b": "R11", "latency": 3})
    assert "L16" not in sim.state.link_metrics and sim.state.link_health["L16"]["health"] == "healthy"
    run(sim, 3)
    assert sim.state.link_metrics["L16"]["status"] == "up" and sim.state.link_health["L16"]["health"] == "healthy"
    failure.fail_link(sim.state, "L16")                            # faults work on new elements
    run(sim, 3)
    assert sim.state.link_health["L16"]["health"] == "down"


def test_failure_after_edit_uses_new_graph(sim):
    sim.edit("remove_link", {"id": "L8"})
    sim.repin_static()
    failure.fail_link(sim.state, "L7")                             # on the new preferred path R4-R7
    run(sim, 4)
    assert sim.state.healing_path.nodes == ["R1", "R2", "R5", "R8", "R9", "R10"]   # cost 35, avoids L7 and L8


def test_latency_change_resets_smoothing_and_detection_base(sim):
    run(sim, 3)
    assert "L8" in sim.state.ewma
    sim.edit("update_link", {"id": "L8", "latency": 40})
    assert "L8" not in sim.state.ewma
    run(sim, 6)
    assert sim.state.link_health["L8"]["health"] == "healthy"      # 40 ms is normal for the new base


def test_undo_redo_restore_topology_with_fresh_state(sim):
    run(sim, 3)
    sim.edit("remove_link", {"id": "L8"})
    assert "L8" not in sim.topology.links
    imp = sim.undo()
    assert imp["kind"] == "undo" and "L8" in sim.topology.links
    assert sim.state.link_health["L8"] == {"health": "healthy", "reason": None, "since": sim.state.tick}
    assert imp["static"] == "restored" and sim.state.static_valid()
    run(sim, 2)
    assert sim.state.link_metrics["L8"]["status"] == "up"
    imp = sim.redo()
    assert imp["kind"] == "redo" and "L8" not in sim.topology.links


def test_counters_stay_monotonic_through_undo_and_redo(sim):
    sim.edit("add_node", {"x": 1, "y": 1})
    sim.undo()
    assert "R11" not in sim.topology.nodes and sim.topology.next_node == 12
    assert sim.edit("add_node", {"x": 2, "y": 2})["id"] == "R12"
    sim.undo()
    sim.redo()
    assert "R12" in sim.topology.nodes and sim.topology.next_node == 13
    assert sim.topology.version > 0


def test_new_edit_clears_redo_and_history_is_capped(sim):
    sim.edit("add_node", {"x": 1, "y": 1})
    sim.undo()
    assert sim.can_redo
    sim.edit("add_node", {"x": 3, "y": 3})
    assert not sim.can_redo
    for _ in range(60):
        sim.edit("move_node", {"id": "R3", "x": 5, "y": 5 + sim.topology.layout_version % 50})
    assert len(sim._undo) == 50
    with pytest.raises(TopologyError, match="Nothing to redo"):
        sim.redo()


def test_undo_everything_then_nothing_to_undo(sim):
    with pytest.raises(TopologyError, match="Nothing to undo"):
        sim.undo()


def test_dirty_flag_tracks_content(sim, tmp_path, monkeypatch):
    monkeypatch.setattr(topology_store, "TOPO_DIR", str(tmp_path))
    assert not sim.dirty
    sim.edit("add_node", {"x": 1, "y": 1})
    assert sim.dirty and sim.state.topology_dirty
    sim.undo()
    assert not sim.dirty                                            # back to the saved content
    sim.edit("add_node", {"x": 1, "y": 1})
    sim.save_as("my_net")
    assert not sim.dirty and sim.topology.name == "my_net"


def test_scenario_start_asks_before_dropping_unsaved_edits(sim, tmp_path):
    import json
    sc = tmp_path / "ring_sc.json"
    sc.write_text(json.dumps({"name": "ring_sc", "duration": 5, "topology": "small_ring",
                              "events": [{"t": 1, "op": "fail_link", "id": "L2"}]}))
    sim.edit("add_node", {"x": 1, "y": 1})
    with pytest.raises(TopologyDirty):
        sim.start_scenario(str(sc))
    assert "R11" in sim.topology.nodes                              # nothing was lost
    sim.start_scenario(str(sc), confirm=True)
    assert sim.topology.name == "small_ring" and sim.state.scenario["running"]
    sim.undo()                                                      # the replaced work is recoverable
    assert "R11" in sim.topology.nodes


def test_scenario_on_clean_other_topology_loads_without_asking(sim, tmp_path):
    import json
    sc = tmp_path / "grid_sc.json"
    sc.write_text(json.dumps({"name": "grid_sc", "duration": 6, "topology": "grid_3x3",
                              "events": [{"t": 2, "op": "fail_link", "id": "L1"}]}))
    sim.run_scenario(str(sc))
    assert sim.topology.name == "grid_3x3"


def test_scenario_with_missing_id_fails_clearly(sim, tmp_path):
    import json
    sim.edit("remove_link", {"id": "L8"})
    sc = tmp_path / "bad.json"
    sc.write_text(json.dumps({"name": "x", "duration": 5, "events": [{"t": 1, "op": "fail_link", "id": "L8"}]}))
    with pytest.raises(ValueError, match="unknown id in scenario event"):
        sim.start_scenario(str(sc))
    link_failure = next(s for s in sim.scenarios() if s["name"] == "link_failure")
    assert not link_failure["runnable"] and "L8" in link_failure["problem"]
    assert next(s for s in sim.scenarios() if s["name"] == "off_path_failure")["runnable"]


def test_edit_during_scenario_marks_the_run_as_edited(sim):
    sim.start_scenario("link_failure")
    run(sim, 5)
    sim.edit("add_node", {"x": 1, "y": 1})
    assert sim.state.scenario["edited"] is True
    run_to(sim, 60)
    assert sim.summary()["topology_edited"] is True


def test_unedited_scenario_is_not_marked_and_keeps_reference_numbers(sim):
    s = sim.run_scenario("link_failure")
    assert s["topology_edited"] is False and (s["static"]["lost"], s["healing"]["lost"]) == (3000, 200)


def test_preview_changes_nothing_and_matches_the_real_edit(sim):
    before = sim.topology
    p = sim.preview("add_link", {"a": "R1", "b": "R10", "latency": 20})
    assert sim.topology is before and sim.state.topology_version == 0 and not sim._undo
    real = sim.edit("add_link", {"a": "R1", "b": "R10", "latency": 20})
    for k in ("preferred_after", "healing", "static", "message"):
        assert p[k] == real[k]
    assert p["preview"] is True


def test_impact_for_planned_delete_off_the_path(sim):
    imp = sim.edit("remove_link", {"id": "L14"})
    assert imp["healing"] == "unchanged" and imp["static"] == "unchanged"
    assert imp["message"].endswith("Routes are unchanged.")


def test_events_record_topology_edits(sim):
    run(sim, 4)
    sim.edit("add_node", {"x": 1, "y": 1})
    ev = sim.state.events[-1]
    assert ev["kind"] == "topology" and ev["tick"] == 4 and "R11" in ev["message"]


def test_reset_topology_loads_default(sim):
    sim.edit("remove_node", {"id": "R5"})
    sim.reset_topology()
    assert len(sim.topology.nodes) == 10 and sim.state.tick == 0 and not sim.dirty
    assert sim.state.healing_path.nodes == BASE


# ------------------------------------------------------------------ concurrency

def test_edits_from_one_thread_while_another_steps():
    sim = Simulation(load_topology(), noise=True, seed=3, log=False)
    errors: list[BaseException] = []

    def stepper():
        try:
            for _ in range(200):
                sim.step()
        except BaseException as e:      # noqa: BLE001 - the test reports any failure
            errors.append(e)

    def editor():
        try:
            for i in range(120):
                try:
                    ids = list(sim.topology.nodes)
                    links = list(sim.topology.links)
                    k = i % 6
                    if k == 0:
                        sim.edit("add_node", {"x": 100 + i, "y": 100})
                    elif k == 1 and len(ids) > 3:
                        sim.edit("add_link", {"a": ids[-1], "b": ids[i % len(ids)], "latency": 4})
                    elif k == 2:
                        sim.edit("update_link", {"id": links[i % len(links)], "latency": 3 + i % 9})
                    elif k == 3:
                        sim.edit("remove_link", {"id": links[i % len(links)]})
                    elif k == 4 and len(ids) > 12:
                        sim.edit("remove_node", {"id": ids[5]})
                    else:
                        sim.undo() if sim.can_undo else None
                except TopologyError:
                    pass                  # rejected edits are fine; crashes are not
        except BaseException as e:      # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=stepper), threading.Thread(target=editor)]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    assert not errors, errors
    sim.step()
    st, t = sim.state, sim.topology
    assert set(st.link_metrics) == set(t.links)
    assert set(st.link_health) <= set(t.links) and set(st.history) <= set(t.links)
    assert st.failed_links <= set(t.links) and st.dead_nodes <= set(t.nodes)
    if st.healing_path:
        assert set(st.healing_path.links) <= set(t.links)
