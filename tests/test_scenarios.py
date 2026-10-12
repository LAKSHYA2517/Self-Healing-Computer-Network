import pytest

from simulation import Simulation, list_scenarios
from topology import load_topology

ALT = ["R1", "R2", "R4", "R7", "R9", "R10"]

# name: (detected tick, reroute tick, recovery ticks, lost static/healing,
#        outage static/healing, route changes [(tick, kind)])
REFERENCE = {
    "link_failure": (11, 11, 2, (3000, 200), (30, 2), [(11, "reroute"), (44, "failback")]),
    "link_degradation": (12, 12, 3, (750, 75), (30, 3), [(12, "reroute"), (44, "failback")]),
    "node_failure": (11, 11, 2, (3000, 200), (30, 2), [(11, "reroute"), (44, "failback")]),
    "off_path_failure": (11, None, None, (0, 0), (0, 0), []),
}


def run(name, **kw):
    sim = Simulation(load_topology(), log=False, **kw)
    return sim, sim.run_scenario(name)


@pytest.mark.parametrize("name", REFERENCE)
def test_reference_numbers(name):
    detected, reroute, recovery, lost, outage, changes = REFERENCE[name]
    sim, s = run(name, noise=False)
    st = sim.state
    assert s["ticks"] == 60
    assert (s["static"]["lost"], s["healing"]["lost"]) == lost
    assert (s["static"]["outage_ticks"], s["healing"]["outage_ticks"]) == outage
    assert s["static"]["sent"] == s["healing"]["sent"] == 6000
    assert s["static"]["route_changes"] == 0
    assert s["healing"]["route_changes"] == len(changes)
    assert [(c["tick"], c["kind"]) for c in st.route_changes] == changes
    f = s["healing"]["faults"][0]
    assert f["detected_tick"] == detected
    assert f["reroute_tick"] == reroute and f["recovery_ticks"] == recovery
    assert min(d["tick"] for d in st.detections) == detected
    assert st.scenario["finished"] and not st.scenario["running"]
    assert sim.summary() == s


def test_availability_percentages():
    _, s = run("link_failure", noise=False)
    assert s["static"]["availability_pct"] == 50.0
    assert s["healing"]["availability_pct"] == pytest.approx(96.67)


def test_reroute_paths_and_node_inference():
    sim, _ = run("link_failure", noise=False)
    assert sim.state.route_changes[0]["to"] == "-".join(ALT) and sim.state.route_changes[0]["cost"] == 34
    sim, _ = run("node_failure", noise=False)
    assert {d["id"] for d in sim.state.detections if d["tick"] == 11} == {"L4", "L5", "L8", "L9", "R5"}
    assert sim.state.route_changes[0]["reason"] == "node failure"


def test_off_path_fault_detected_but_no_reroute():
    sim, s = run("off_path_failure", noise=False)
    assert s["healing"]["avg_delay_ms"] == s["static"]["avg_delay_ms"] == 33.0
    assert any(d["id"] == "L14" for d in sim.state.detections)


def test_noise_run_has_no_false_positives():
    sim = Simulation(load_topology(), noise=True, seed=1, log=False)
    sim.start_scenario("link_failure")
    for _ in range(60):
        sim.step()
    st = sim.state
    first = st.route_changes[0]
    assert first["tick"] <= 10 + 3 and first["kind"] == "reroute"
    assert all(d["tick"] >= 10 for d in st.detections)


def test_quiet_noise_run_never_reroutes():
    sim = Simulation(load_topology(), noise=True, seed=7, log=False)
    for _ in range(300):
        sim.step()
    assert sim.state.route_changes == [] and sim.state.detections == []


def test_scenario_listing_and_validation(tmp_path):
    names = {s["name"] for s in list_scenarios()}
    assert set(REFERENCE) <= names
    sim = Simulation(load_topology(), noise=False, log=False)
    with pytest.raises(ValueError):
        sim.load_scenario("does_not_exist")
    bad = tmp_path / "bad.json"
    bad.write_text('{"name":"x","duration":5,"events":[{"t":1,"op":"fail_link","id":"L99"}]}')
    with pytest.raises(ValueError):
        sim.load_scenario(str(bad))


def test_reset_clears_run():
    sim, _ = run("link_failure", noise=False)
    sim.reset()
    st = sim.state
    assert st.tick == 0 and not st.route_changes and not st.fault_log and not st.series["healing"]
    assert st.healing_path.nodes == st.baseline_path.nodes and not st.scenario["running"]
