"""Single shared, thread-safe network state."""
import threading
import time
from collections import deque

from routing import PathResult, compute_path, path_is_intact
from topology import Topology


class State:
    """Shared by the monitor thread and Flask handlers; all access goes through `lock`."""

    def __init__(self, topology: Topology):
        self.lock = threading.RLock()
        self.topology = topology
        self.failed_links: set[str] = set()
        self.failed_nodes: set[str] = set()
        self.link_metrics: dict[str, dict] = {}
        self.history = {lid: deque(maxlen=60) for lid in topology.links}
        self.events: deque = deque(maxlen=200)
        self.baseline_path: PathResult = self.compute_baseline()

    def compute_baseline(self) -> PathResult:
        """Static-cost shortest path with no failures."""
        t = self.topology
        return compute_path(t, t.source, t.destination)

    def log_event(self, level: str, message: str) -> None:
        with self.lock:
            self.events.append({"ts": time.time(), "level": level, "message": message})

    def route_status(self) -> str:
        with self.lock:
            ok = path_is_intact(self.baseline_path, self.failed_links, self.failed_nodes)
            return "OK" if ok else "BROKEN"

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "failed_links": sorted(self.failed_links),
                "failed_nodes": sorted(self.failed_nodes),
                "baseline_path": vars(self.baseline_path),
                "route_status": self.route_status(),
                "link_metrics": {k: dict(v) for k, v in self.link_metrics.items()},
                "history": {k: list(v) for k, v in self.history.items()},
                "events": list(self.events),
            }
