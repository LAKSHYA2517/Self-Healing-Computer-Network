import pytest

from routing import PathResult
from topology import load_topology
from traffic import evaluate

T = load_topology()
PATH = PathResult(["R1", "R2", "R5"], ["L1", "L4"], 15)   # L1 100 Mbps, L4 100 Mbps


def m(lat, loss, util, status="up"):
    return {"status": status, "latency_ms": lat, "loss_pct": loss, "util_pct": util}


def test_formulas():
    r = evaluate(T, PATH, {"L1": m(5, 10, 20), "L4": m(10, 20, 50)})
    ratio = 0.9 * 0.8
    assert r["delivery_pct"] == pytest.approx(72.0)
    assert r["lost_packets"] == 28
    assert r["delay_ms"] == 15
    assert r["throughput_mbps"] == pytest.approx(50 * ratio)   # min(80, 50) * ratio
    assert r["available"] is False


def test_clean_path_available():
    r = evaluate(T, PATH, {"L1": m(5, 0, 30), "L4": m(10, 0, 30)})
    assert (r["delivery_pct"], r["lost_packets"], r["throughput_mbps"], r["available"]) == (100, 0, 70, True)


def test_down_link_and_missing_path():
    r = evaluate(T, PATH, {"L1": m(5, 0, 30), "L4": m(None, 100, 0, "down")})
    assert (r["delivery_pct"], r["lost_packets"], r["delay_ms"], r["throughput_mbps"]) == (0, 100, None, 0)
    assert r["available"] is False
    r = evaluate(T, None, {})
    assert r["delivery_pct"] == 0 and r["delay_ms"] is None


def test_availability_threshold():
    r = evaluate(T, PATH, {"L1": m(5, 10, 0), "L4": m(10, 0, 0)})
    assert r["delivery_pct"] == 90 and r["available"] is True
