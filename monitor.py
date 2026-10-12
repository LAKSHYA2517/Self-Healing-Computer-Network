"""Simulated per-link metrics sampling."""
import random

from state import State
from topology import Topology


def _next_util(rng: random.Random, prev: float) -> float:
    """Bounded random walk between 5 and 60."""
    return min(60.0, max(5.0, prev + rng.choice((-5, 0, 5))))


def sample(state: State, topology: Topology, rng: random.Random, noise: bool = True,
           util: dict | None = None) -> dict[str, dict]:
    """One round of metrics for every link. `util` carries the per-link random walk between calls."""
    util = {} if util is None else util
    out = {}
    for l in topology.links.values():
        if l.id in state.failed_links or state.failed_nodes & {l.a, l.b}:
            out[l.id] = {"status": "down", "latency_ms": None, "loss_pct": 100.0, "util_pct": 0.0}
            continue
        if noise:
            util[l.id] = u = _next_util(rng, util.get(l.id, rng.uniform(5, 60)))
            lat = l.latency * rng.uniform(0.9, 1.15)
            loss = min(2.0, max(0.0, rng.gauss(0.3, 0.2)))
        else:
            lat, loss, u = float(l.latency), 0.0, 30.0
        imp = state.impairments.get(l.id)
        if imp:
            loss = min(100.0, loss + imp["loss_pct"])
            lat *= imp["latency_mult"]
            if imp["util_pct"] is not None:
                u = imp["util_pct"]
        if u > 90:
            loss = min(100.0, loss + (u - 90))
        out[l.id] = {"status": "up", "latency_ms": lat, "loss_pct": loss, "util_pct": u}
    return out
