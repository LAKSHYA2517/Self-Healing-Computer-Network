import pytest

import failure
from config import HOLD_DOWN_TICKS
from simulation import Simulation
from topology import load_topology

BASE = ["R1", "R2", "R5", "R7", "R9", "R10"]
ALT = ["R1", "R2", "R4", "R7", "R9", "R10"]


@pytest.fixture
def sim():
    return Simulation(load_topology(), noise=False, log=False)


def run(sim, n):
    for _ in range(n):
        sim.step()


def run_until(sim, tick):
    run(sim, tick - sim.state.tick)


def test_quiet_network_has_no_route_changes(sim):
    run(sim, 30)
    st = sim.state
    assert st.route_changes == [] and st.healing_path.nodes == BASE
    assert st.series["healing"][-1]["delivery_pct"] == 100


def test_reroute_then_failback_ticks(sim):
    st = sim.state
    run_until(sim, 10)
    failure.fail_link(st, "L8")
    run_until(sim, 11)
    assert st.healing_path.nodes == BASE        # detected only after 2nd bad sample
    run_until(sim, 12)                          # step at tick 11 detects + reroutes
    assert st.healing_path.nodes == ALT
    assert [(c["tick"], c["kind"]) for c in st.route_changes] == [(11, "reroute")]
    assert st.route_changes[0]["cost"] == 34 and st.route_changes[0]["reason"] == "link failure"
    run_until(sim, 40)
    failure.restore_link(st, "L8")
    run_until(sim, 45)
    assert [(c["tick"], c["kind"]) for c in st.route_changes] == [(11, "reroute"), (44, "failback")]
    assert st.healing_path.nodes == BASE


def test_hold_down_delays_failback(sim):
    st = sim.state
    run_until(sim, 10)
    failure.fail_link(st, "L8")
    run_until(sim, 12)
    failure.restore_link(st, "L8")              # healthy again at tick 16, hold-down until 21
    run_until(sim, 40)
    changes = st.route_changes
    assert [c["kind"] for c in changes] == ["reroute", "failback"]
    assert changes[1]["tick"] - changes[0]["tick"] >= HOLD_DOWN_TICKS
    assert changes[1]["tick"] == 11 + HOLD_DOWN_TICKS


def test_no_path_then_recovery(sim):
    st = sim.state
    run_until(sim, 5)
    failure.fail_link(st, "L1")
    failure.fail_link(st, "L2")
    run_until(sim, 10)
    assert st.healing_path is None
    assert [e["level"] for e in st.events].count("CRITICAL") == 1
    row = st.series["healing"][-1]
    assert row["delivery_pct"] == 0 and row["delay_ms"] is None and row["path"] is None
    failure.restore_link(st, "L1")
    failure.restore_link(st, "L2")
    run_until(sim, 20)
    assert st.healing_path is not None and st.healing_path.nodes == BASE
    assert st.route_changes[-1]["kind"] == "recovery"
    assert st.series["healing"][-1]["delivery_pct"] == 100


def test_degraded_without_alternative_stays_and_logs_once(sim):
    st = sim.state
    failure.fail_link(st, "L2")                 # R1 only has L1 left
    failure.degrade_link(st, "L1", 20)
    run(sim, 20)
    assert st.link_health["L1"]["health"] == "degraded"
    assert st.healing_path.nodes == BASE and st.route_changes == []
    assert [e["message"] for e in st.events].count("No better path, staying on degraded route") == 1


def test_flapping_link_causes_at_most_two_route_changes(sim):
    st = sim.state
    run_until(sim, 10)
    for _ in range(5):
        failure.fail_link(st, "L8")
        run(sim, 2)
        failure.restore_link(st, "L8")
        run(sim, 2)
    run(sim, 30)
    assert len(st.route_changes) <= 2
    assert st.healing_path.nodes == BASE


def test_congestion_triggers_reroute(sim):
    st = sim.state
    run_until(sim, 5)
    failure.congest_link(st, "L8", 95)
    run(sim, 6)
    assert st.link_health["L8"]["reason"] == "congestion"
    assert st.healing_path.nodes == ALT and st.route_changes[0]["reason"] == "degradation"
