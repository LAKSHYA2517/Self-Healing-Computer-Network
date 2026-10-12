import pathlib

import pytest

from detector import Detector, classify
from state import State
from topology import load_topology

GOOD = {"status": "up", "latency_ms": 5.0, "loss_pct": 0.0, "util_pct": 30.0}
DOWN = {"status": "down", "latency_ms": None, "loss_pct": 100.0, "util_pct": 0.0}
LOSSY = {**GOOD, "loss_pct": 10.0}


@pytest.fixture
def env():
    topo = load_topology()
    return topo, State(topo), Detector(topo)


def feed(env, link, sample, n):
    topo, st, det = env
    for _ in range(n):
        st.link_metrics = {l: dict(GOOD) for l in topo.links}
        st.link_metrics[link] = dict(sample)
        det.update(st)
        st.tick += 1
    return st.link_health[link]["health"]


def test_down_threshold(env):
    assert feed(env, "L1", DOWN, 1) == "healthy"
    assert feed(env, "L1", DOWN, 1) == "down"


def test_degraded_threshold(env):
    assert feed(env, "L1", LOSSY, 2) == "healthy"
    assert feed(env, "L1", LOSSY, 1) == "degraded"


def test_recovery_needs_five_good_samples(env):
    feed(env, "L1", DOWN, 2)
    assert feed(env, "L1", GOOD, 4) == "down"
    assert feed(env, "L1", GOOD, 1) == "healthy"


def test_interrupted_good_run_does_not_recover(env):
    feed(env, "L1", LOSSY, 3)
    feed(env, "L1", GOOD, 4)
    assert feed(env, "L1", LOSSY, 1) == "degraded"
    assert feed(env, "L1", GOOD, 4) == "degraded"


def test_degraded_reasons():
    assert classify({**GOOD, "loss_pct": 6.0}, 5) == ("degraded", "loss")
    assert classify({**GOOD, "latency_ms": 13.0}, 5) == ("degraded", "latency")
    assert classify({**GOOD, "util_pct": 90.0}, 5) == ("degraded", "congestion")
    assert classify({**GOOD, "latency_ms": 12.5, "loss_pct": 5.0, "util_pct": 85.0}, 5) == ("good", None)
    assert classify(DOWN, 5) == ("down", None)


def test_reason_recorded_in_health(env):
    feed(env, "L1", {**GOOD, "util_pct": 95.0}, 3)
    assert env[1].link_health["L1"]["reason"] == "congestion"


def test_reason_follows_current_cause(env):
    feed(env, "L1", LOSSY, 3)
    assert env[1].link_health["L1"]["reason"] == "loss"
    feed(env, "L1", {**GOOD, "util_pct": 95.0}, 1)
    assert env[1].link_health["L1"]["reason"] == "congestion"


def test_node_inference(env):
    topo, st, det = env
    incident = [l.id for l in topo.links.values() if "R5" in (l.a, l.b)]
    assert len(incident) == 4
    for _ in range(2):
        st.link_metrics = {l: dict(DOWN if l in incident else GOOD) for l in topo.links}
        det.update(st)
        st.tick += 1
    assert st.dead_nodes == {"R5"}
    assert any("node R5 DOWN (all 4 links down)" in e["message"] for e in st.events)


def test_ewma_ignores_down_and_resets_on_recovery(env):
    topo, st, det = env
    feed(env, "L1", {**GOOD, "latency_ms": 6.0}, 1)
    feed(env, "L1", DOWN, 2)
    assert st.link_health["L1"]["health"] == "down"
    assert st.ewma["L1"]["latency_ms"] == 6.0
    feed(env, "L1", {**GOOD, "latency_ms": 8.0}, 5)
    assert st.ewma["L1"]["latency_ms"] == 8.0   # reset to latest on recovery


@pytest.mark.parametrize("module", ["detector.py", "engine.py"])
def test_detection_modules_do_not_read_ground_truth(module):
    src = (pathlib.Path(__file__).parent.parent / module).read_text()
    for name in ("failed_links", "failed_nodes", "impairments"):
        assert name not in src, f"{module} mentions {name}"
