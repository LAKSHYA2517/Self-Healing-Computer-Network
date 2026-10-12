"""Link health detection from metrics only (healthy / degraded / down) plus node inference."""
from config import (EWMA_ALPHA, K_DEGRADED, K_DOWN, K_RECOVER, LATENCY_DEGRADED_FACTOR,
                    LOSS_DEGRADED_PCT, UTIL_CONGESTED_PCT)
from state import State
from topology import Topology

_KINDS = ("down", "degraded", "good")


def classify(m: dict, base_latency: float) -> tuple[str, str | None]:
    """Classify one sample as ("down"|"degraded"|"good", reason)."""
    if m["status"] == "down":
        return "down", None
    if m["loss_pct"] > LOSS_DEGRADED_PCT:
        return "degraded", "loss"
    if m["latency_ms"] > LATENCY_DEGRADED_FACTOR * base_latency:
        return "degraded", "latency"
    if m["util_pct"] > UTIL_CONGESTED_PCT:
        return "degraded", "congestion"
    return "good", None


class Detector:
    """Per-link consecutive-sample counters with hysteresis, and EWMA smoothing."""

    def __init__(self, topology: Topology):
        self.topology = topology
        self._count = {lid: dict.fromkeys(_KINDS, 0) for lid in topology.links}
        self._reason: dict[str, str | None] = {}
        self._incident: dict[str, list[str]] = {n: [] for n in topology.nodes}
        for l in topology.links.values():
            self._incident[l.a].append(l.id)
            self._incident[l.b].append(l.id)

    def update(self, state: State) -> None:
        """Consume this tick's samples from state.link_metrics and update health."""
        with state.lock:
            for lid, link in self.topology.links.items():
                m = state.link_metrics.get(lid)
                if m is not None:
                    self._update_link(state, link, m)
            self._infer_nodes(state)

    def _update_link(self, state: State, link, m: dict) -> None:
        kind, reason = classify(m, link.latency)
        c = self._count[link.id]
        for k in _KINDS:
            c[k] = c[k] + 1 if k == kind else 0
        if kind == "degraded":
            self._reason[link.id] = reason
            if state.link_health[link.id]["health"] == "degraded":
                state.link_health[link.id]["reason"] = reason
        if kind != "down":
            self._smooth(state, link.id, m)
        h = state.link_health[link.id]
        name = f"{link.id} ({link.a}-{link.b})"
        if h["health"] != "down" and c["down"] >= K_DOWN:
            self._set(state, link.id, "down", "link down")
            self._detect(state, link.id, "down", f"DETECTED {name} DOWN after {c['down']}/{K_DOWN} samples")
        elif h["health"] == "healthy" and c["degraded"] >= K_DEGRADED:
            why = self._reason[link.id]
            self._set(state, link.id, "degraded", why)
            self._detect(state, link.id, "degraded",
                         f"DETECTED {name} DEGRADED ({why}) after {c['degraded']}/{K_DEGRADED} samples")
        elif h["health"] != "healthy" and c["good"] >= K_RECOVER:
            self._set(state, link.id, "healthy", None)
            state.ewma[link.id] = _ewma_point(m)
            state.log_event("INFO", f"{name} HEALTHY again after {c['good']}/{K_RECOVER} good samples")

    @staticmethod
    def _smooth(state: State, lid: str, m: dict) -> None:
        prev, cur = state.ewma.get(lid), _ewma_point(m)
        state.ewma[lid] = cur if prev is None else {
            k: EWMA_ALPHA * cur[k] + (1 - EWMA_ALPHA) * prev[k] for k in cur}

    @staticmethod
    def _set(state: State, lid: str, health: str, reason: str | None) -> None:
        state.link_health[lid] = {"health": health, "reason": reason, "since": state.tick}

    @staticmethod
    def _detect(state: State, lid: str, health: str, text: str) -> None:
        state.detections.append({"tick": state.tick, "kind": "link", "id": lid, "health": health})
        state.log_event("WARN", text)

    def _infer_nodes(self, state: State) -> None:
        """A node is dead when it has links and every one of them is down."""
        dead = {n for n, inc in self._incident.items()
                if inc and all(state.link_health[l]["health"] == "down" for l in inc)}
        for n in sorted(dead - state.dead_nodes):
            state.detections.append({"tick": state.tick, "kind": "node", "id": n, "health": "down"})
            state.log_event("WARN", f"DETECTED node {n} DOWN (all {len(self._incident[n])} links down)")
        for n in sorted(state.dead_nodes - dead):
            state.log_event("INFO", f"Node {n} RECOVERED (links healthy again)")
        state.dead_nodes = dead


def _ewma_point(m: dict) -> dict:
    return {"latency_ms": m["latency_ms"], "loss_pct": m["loss_pct"], "util_pct": m["util_pct"]}
