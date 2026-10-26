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
        self._count: dict[str, dict[str, int]] = {}
        self._reason: dict[str, str | None] = {}
        self._incident: dict[str, list[str]] = {}
        self._topology: Topology | None = None
        self._sync(topology)

    def _sync(self, topology: Topology) -> None:
        """Follow the current topology: rebuild router->links and drop counters of vanished links."""
        if topology is self._topology:
            return
        self._topology = topology
        self._incident = {n: [] for n in topology.nodes}
        for l in topology.links.values():
            self._incident[l.a].append(l.id)
            self._incident[l.b].append(l.id)
        self.forget_links([lid for lid in self._count if lid not in topology.links])

    def forget_links(self, link_ids) -> None:
        """Drop all counters of removed links."""
        for lid in link_ids:
            self._count.pop(lid, None)
            self._reason.pop(lid, None)

    def update(self, state: State) -> None:
        """Consume this tick's samples from state.link_metrics and update health."""
        with state.lock:
            self._sync(state.topology)
            for lid, link in state.topology.links.items():
                m = state.link_metrics.get(lid)
                if m is not None:
                    self._update_link(state, link, m)
            self._infer_nodes(state)
            self._publish_progress(state)

    def _update_link(self, state: State, link, m: dict) -> None:
        kind, reason = classify(m, link.latency)
        c = self._count.setdefault(link.id, dict.fromkeys(_KINDS, 0))
        h = _health(state, link.id)
        for k in _KINDS:
            c[k] = c[k] + 1 if k == kind else 0
        if kind == "degraded":
            self._reason[link.id] = reason
            if h["health"] == "degraded":
                h["reason"] = reason
        if kind != "down":
            self._smooth(state, link.id, m)
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
            state.log_event("INFO", f"{name} HEALTHY again after {c['good']}/{K_RECOVER} good samples",
                            "restore")

    def _publish_progress(self, state: State) -> None:
        """Expose how close each link is to its next health transition (for teaching views)."""
        out = {}
        for lid in state.topology.links:
            c = self._count.get(lid, dict.fromkeys(_KINDS, 0))
            health = _health(state, lid)["health"]
            if health != "down" and c["down"] > 0:
                out[lid] = {"pending": "down", "count": c["down"], "needed": K_DOWN}
            elif health == "healthy" and c["degraded"] > 0:
                out[lid] = {"pending": "degraded", "count": c["degraded"], "needed": K_DEGRADED}
            elif health != "healthy" and c["good"] > 0:
                out[lid] = {"pending": "recover", "count": c["good"], "needed": K_RECOVER}
            else:
                out[lid] = {"pending": None, "count": 0, "needed": 0}
        state.detector_progress = out

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
        state.log_event("WARN", text, "detect")

    def _infer_nodes(self, state: State) -> None:
        """A node is dead when it has links and every one of them is down."""
        dead = {n for n, inc in self._incident.items()
                if inc and all(_health(state, l)["health"] == "down" for l in inc)}
        for n in sorted(dead - state.dead_nodes):
            state.detections.append({"tick": state.tick, "kind": "node", "id": n, "health": "down"})
            state.log_event("WARN", f"DETECTED node {n} DOWN (all {len(self._incident[n])} links down)",
                            "detect")
        for n in sorted(state.dead_nodes - dead):
            state.log_event("INFO", f"Node {n} RECOVERED (links healthy again)", "restore")
        state.dead_nodes = dead


def _health(state: State, lid: str) -> dict:
    """The link's health record, created healthy on first sight (links can be added at runtime)."""
    return state.link_health.setdefault(lid, {"health": "healthy", "reason": None, "since": state.tick})


def _ewma_point(m: dict) -> dict:
    return {"latency_ms": m["latency_ms"], "loss_pct": m["loss_pct"], "util_pct": m["util_pct"]}
