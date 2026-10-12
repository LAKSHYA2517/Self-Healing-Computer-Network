import pytest

from routing import compute_healing_path, compute_path, live_cost, path_is_intact
from topology import load_topology

T = load_topology()
ALT = ["R1", "R2", "R4", "R7", "R9", "R10"]


def path(**kw):
    return compute_path(T, "R1", "R10", **kw)


def test_baseline():
    p = path()
    assert p.nodes == ["R1", "R2", "R5", "R7", "R9", "R10"]
    assert p.links == ["L1", "L4", "L8", "L11", "L15"]
    assert p.cost == 33


def test_link_failure_alternate():
    p = path(failed_links={"L8"})
    assert (p.nodes, p.cost) == (ALT, 34)


def test_node_failure_alternate():
    p = path(failed_nodes={"R5"})
    assert (p.nodes, p.cost) == (ALT, 34)


def test_isolated_source_and_failed_endpoint():
    assert path(failed_links={"L1", "L2"}) is None
    assert path(failed_nodes={"R10"}) is None


def test_path_is_intact():
    p = path()
    assert path_is_intact(p, set(), set())
    assert path_is_intact(p, {"L14"}, {"R3"})
    assert not path_is_intact(p, {"L8"}, set())
    assert not path_is_intact(p, set(), {"R5"})


def test_live_cost_penalises_loss_and_util():
    def metrics(**over):
        m = {l: {"loss_pct": 0.0, "util_pct": 0.0} for l in T.links}
        m["L8"] = {"loss_pct": 0.0, "util_pct": 0.0, **over}
        return m
    clean = path(cost_mode="live", live_metrics=metrics())
    assert clean.cost == 33  # normal jitter adds nothing
    assert path(cost_mode="live", live_metrics=metrics(loss_pct=2.0)).cost == 33
    assert path(cost_mode="live", live_metrics=metrics(loss_pct=2.4)).cost == pytest.approx(33.8)
    assert path(cost_mode="live", live_metrics=metrics(util_pct=61.0)).cost == pytest.approx(33.5)
    # heavy loss on L8 makes the R4 route cheaper
    assert path(cost_mode="live", live_metrics=metrics(loss_pct=50.0)).nodes == ALT


def test_live_cost_formula():
    assert live_cost(10, {"latency_ms": 11.5, "loss_pct": 2.0, "util_pct": 60.0}) == 10
    assert live_cost(10, {"latency_ms": 20.0, "loss_pct": 5.0, "util_pct": 80.0}) == 10 + 7 + 6 + 10
    assert live_cost(10, {}, "degraded") == 60
    assert live_cost(10, None) == 10


def test_healing_path_uses_health_and_dead_nodes():
    health = {l: {"health": "healthy"} for l in T.links}
    assert compute_healing_path(T, health, set(), {}).cost == 33
    health["L8"]["health"] = "degraded"          # +50 penalty pushes the path off L8
    assert compute_healing_path(T, health, set(), {}).nodes == ALT
    health["L8"]["health"] = "healthy"
    assert compute_healing_path(T, health, {"R5"}, {}).nodes == ALT
    assert compute_healing_path(T, health, {"R1"}, {}) is None


def test_bad_cost_mode():
    with pytest.raises(ValueError):
        path(cost_mode="live")
    with pytest.raises(ValueError):
        path(cost_mode="bogus")
