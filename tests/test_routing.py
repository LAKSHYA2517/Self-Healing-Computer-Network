import pytest

from routing import PathResult, compute_path, path_is_intact
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
    assert clean.cost == 33
    assert path(cost_mode="live", live_metrics=metrics(loss_pct=2.0)).cost > clean.cost
    assert path(cost_mode="live", live_metrics=metrics(util_pct=60.0)).cost > clean.cost
    # heavy loss on L8 makes the R4 route cheaper
    assert path(cost_mode="live", live_metrics=metrics(loss_pct=50.0)).nodes == ALT


def test_bad_cost_mode():
    with pytest.raises(ValueError):
        path(cost_mode="live")
    with pytest.raises(ValueError):
        path(cost_mode="bogus")
