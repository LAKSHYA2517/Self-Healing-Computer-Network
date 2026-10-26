"""Single shared, thread-safe network state."""
import threading
from collections import deque

import metrics
from config import (HOLD_DOWN_TICKS, K_DEGRADED, K_DOWN, K_RECOVER, SERIES_LEN,
                    TICK_SECONDS)
from routing import NO_PATH, PathResult, has_path, path_is_intact, preferred_path
from topology import Topology

FLOWS = ("static", "healing")


class State:
    """Shared by the simulation thread and Flask handlers; all access goes through `lock`."""

    def __init__(self, topology: Topology):
        self.lock = threading.RLock()
        self.topology = topology
        self.paused = False                   # set by Simulation; survives reset_run
        self.tick_seconds = TICK_SECONDS
        self.topology_version = 0             # bumped by Simulation on every topology change
        self.topology_dirty = False
        self.reset_run()

    def reset_run(self) -> None:
        """Return every field to its start-of-run value."""
        t = self.topology
        self.tick = 0
        self.failed_links: set[str] = set()
        self.failed_nodes: set[str] = set()
        self.impairments: dict[str, dict] = {}
        self.link_metrics: dict[str, dict] = {}
        self.history = {lid: deque(maxlen=60) for lid in t.links}
        self.events: deque = deque(maxlen=200)
        # baseline_path = preferred path (best on base latencies, ignoring faults); the failback target.
        # static_path = the manually pinned route of the static flow; only reset or re-pin changes it.
        self.baseline_path: PathResult = preferred_path(t)
        self.static_path: PathResult = self.baseline_path
        self.link_health = {lid: {"health": "healthy", "reason": None, "since": 0} for lid in t.links}
        self.ewma: dict[str, dict] = {}
        self.dead_nodes: set[str] = set()
        self.healing_path: PathResult | None = self.baseline_path if has_path(self.baseline_path) else None
        self.last_route_change_tick = 0
        self.route_changes: list[dict] = []
        self.reset_flows()
        self.fault_log: list[dict] = []     # ground truth, read only by metrics
        self.detections: list[dict] = []
        self.detector_progress: dict[str, dict] = {}
        self.scenario = {"name": None, "title": None, "duration": 0, "running": False, "finished": False,
                         "edited": False}
        self.frozen_summary: dict | None = None

    def reset_flows(self) -> None:
        """Clear per-flow series, rows and totals (start of a run, or the flow endpoints changed)."""
        self.series = {f: deque(maxlen=SERIES_LEN) for f in FLOWS}
        self.rows = deque(maxlen=5000)
        self.flow_totals = {f: {"sent": 0, "lost": 0, "ticks": 0, "outage_ticks": 0,
                                "delay_sum": 0.0, "delay_n": 0, "thr_sum": 0.0} for f in FLOWS}

    def static_valid(self, topology: Topology | None = None) -> bool:
        """Does the pinned static route still exist on the current (or a given) topology?"""
        p, t = self.static_path, topology or self.topology
        return has_path(p) and all(l in t.links for l in p.links) and all(n in t.nodes for n in p.nodes)

    def log_event(self, level: str, message: str, kind: str = "info") -> None:
        """kind is one of fault, detect, reroute, failback, restore, info, critical."""
        with self.lock:
            self.events.append({"tick": self.tick, "level": level, "kind": kind, "message": message})

    def route_status(self) -> str:
        """Ground truth: is the baseline path free of injected failures?"""
        with self.lock:
            if not has_path(self.baseline_path):
                return "BROKEN"
            ok = path_is_intact(self.baseline_path, self.failed_links, self.failed_nodes)
            return "OK" if ok else "BROKEN"

    def snapshot(self) -> dict:
        with self.lock:
            summary = metrics.compute_summary(self)
            kpis = {}
            for f in FLOWS:
                last = self.series[f][-1] if self.series[f] else {}
                kpis[f] = {**{k: last.get(k) for k in
                              ("delivery_pct", "delay_ms", "throughput_mbps", "available")},
                           "lost_packets": summary[f]["lost"],
                           "route_changes": summary[f]["route_changes"],
                           "availability_pct": summary[f]["availability_pct"]}
            recs = [x["recovery_ticks"] for x in summary["healing"]["faults"]
                    if x["recovery_ticks"] is not None]
            kpis["healing"]["last_recovery_ticks"] = recs[-1] if recs else None
            return {
                "tick": self.tick,
                "topology_version": self.topology_version,
                "topology_dirty": self.topology_dirty,
                "static_path_valid": self.static_valid(),
                "paused": self.paused,
                "tick_seconds": self.tick_seconds,
                "config": {"hold_down_ticks": HOLD_DOWN_TICKS, "k_down": K_DOWN,
                           "k_degraded": K_DEGRADED, "k_recover": K_RECOVER},
                "detector_progress": {k: dict(v) for k, v in self.detector_progress.items()},
                "fault_log": [{"tick": f["tick"], "op": f["op"], "target": f["target"],
                               "restored_tick": f["restored_tick"], "description": f["description"]}
                              for f in self.fault_log],
                "failed_links": sorted(self.failed_links),
                "failed_nodes": sorted(self.failed_nodes),
                "impairments": {k: dict(v) for k, v in self.impairments.items()},
                "baseline_path": vars(self.baseline_path),
                "static_path": vars(self.static_path),
                "healing_path": vars(self.healing_path) if self.healing_path else None,
                "route_status": self.route_status(),
                "link_metrics": {k: dict(v) for k, v in self.link_metrics.items()},
                "link_health": {k: dict(v) for k, v in self.link_health.items()},
                "dead_nodes": sorted(self.dead_nodes),
                "history": {k: list(v) for k, v in self.history.items()},
                "route_changes": list(self.route_changes),
                "kpis": kpis,
                "series": {f: list(self.series[f]) for f in FLOWS},
                "events": list(self.events),
                "scenario": dict(self.scenario),
            }
