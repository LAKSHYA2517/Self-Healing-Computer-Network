"""Background thread producing simulated per-link metrics."""
import random
import threading
import time

import metrics
from state import State


def _next_util(prev: float) -> float:
    """Bounded random walk between 5 and 60."""
    return min(60.0, max(5.0, prev + random.choice((-5, 0, 5))))


def tick(state: State, util: dict[str, float]) -> None:
    """Produce one round of metrics for every link."""
    with state.lock:
        now = time.time()
        for l in state.topology.links.values():
            if l.id in state.failed_links or state.failed_nodes & {l.a, l.b}:
                m = {"status": "down", "latency_ms": None, "loss_pct": 100.0, "util_pct": 0.0}
            else:
                util[l.id] = _next_util(util.get(l.id, random.uniform(5, 60)))
                m = {"status": "up",
                     "latency_ms": l.latency * random.uniform(0.9, 1.15),
                     "loss_pct": min(2.0, max(0.0, random.gauss(0.3, 0.2))),
                     "util_pct": util[l.id]}
            state.link_metrics[l.id] = m
            state.history[l.id].append(m["latency_ms"])
        snapshot, status = dict(state.link_metrics), state.route_status()
    metrics.log_tick(now, snapshot, status)


def start(state: State, interval: float = 1.0) -> threading.Thread:
    """Start the daemon monitor thread."""
    util: dict[str, float] = {}

    def loop() -> None:
        while True:
            tick(state, util)
            time.sleep(interval)

    t = threading.Thread(target=loop, daemon=True, name="monitor")
    t.start()
    return t
