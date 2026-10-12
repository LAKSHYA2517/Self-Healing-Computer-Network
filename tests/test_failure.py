import random

import pytest

import failure
import monitor
from state import State
from topology import load_topology


@pytest.fixture
def st():
    return State(load_topology())


def msgs(st, level=None):
    return [e["message"] for e in st.events if level in (None, e["level"])]


def test_link_fail_restore_flips_status(st):
    assert st.route_status() == "OK"
    failure.fail_link(st, "L8")
    assert st.route_status() == "BROKEN"
    assert msgs(st, "WARN") == ["Baseline route R1-R2-R5-R7-R9-R10 is BROKEN"]
    assert "Link L8 (R5-R7) FAILED" in msgs(st)
    failure.restore_link(st, "L8")
    assert st.route_status() == "OK"
    assert "Baseline route R1-R2-R5-R7-R9-R10 is OK again" in msgs(st, "INFO")


def test_off_path_failure_keeps_ok(st):
    failure.fail_link(st, "L14")
    assert st.route_status() == "OK" and not msgs(st, "WARN")


def test_node_failure_breaks_route(st):
    failure.fail_node(st, "R5")
    assert st.route_status() == "BROKEN"
    failure.restore_node(st, "R5")
    assert st.route_status() == "OK"


def test_unknown_ids(st):
    for fn in (failure.fail_link, failure.restore_link):
        with pytest.raises(KeyError, match="L99"):
            fn(st, "L99")
    with pytest.raises(KeyError, match="R99"):
        failure.fail_node(st, "R99")


def test_idempotent(st):
    failure.fail_link(st, "L8")
    n = len(st.events)
    failure.fail_link(st, "L8")
    failure.restore_link(st, "L1")  # never failed
    assert len(st.events) == n


def test_reset(st):
    failure.fail_link(st, "L8")
    failure.fail_node(st, "R3")
    failure.reset(st)
    assert not st.failed_links and not st.failed_nodes
    assert st.route_status() == "OK"
    assert st.baseline_path.cost == 33


def test_monitor_sample_reflects_failures(st):
    failure.fail_node(st, "R5")
    m = monitor.sample(st, st.topology, random.Random(0), noise=True)
    assert m["L8"]["status"] == "down" and m["L8"]["latency_ms"] is None
    assert m["L1"]["status"] == "up" and 4.5 <= m["L1"]["latency_ms"] <= 5.75
    assert st.snapshot()["route_status"] == "BROKEN"


def test_impairments_validate_idempotent_and_restore_clears(st):
    failure.degrade_link(st, "L8", 25)
    n = len(st.events)
    failure.degrade_link(st, "L8", 25)
    failure.clear_link(st, "L1")
    assert len(st.events) == n
    assert st.impairments["L8"]["loss_pct"] == 25
    m = monitor.sample(st, st.topology, random.Random(0), noise=False)
    assert m["L8"]["loss_pct"] == 25 and m["L8"]["status"] == "up"
    failure.congest_link(st, "L8", 95)
    m = monitor.sample(st, st.topology, random.Random(0), noise=False)
    assert m["L8"]["util_pct"] == 95 and m["L8"]["loss_pct"] == 30  # 25 + (95 - 90)
    failure.restore_link(st, "L8")
    assert "L8" not in st.impairments
    with pytest.raises(KeyError):
        failure.congest_link(st, "L99", 90)
    with pytest.raises(ValueError):
        failure.degrade_link(st, "L8", 150)
    assert [f["id"] for f in st.fault_log] == ["L8", "L8"]
