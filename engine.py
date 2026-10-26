"""Self-healing controller: reroute around detected faults and fail back with hold-down."""
from dataclasses import dataclass

from config import HOLD_DOWN_TICKS
from routing import PathResult, compute_healing_path, has_path, path_cost
from state import State
from topology import Topology, TopologyDiff


@dataclass(frozen=True)
class Decision:
    """What the engine would do about a topology change (no side effects)."""
    result: str                      # unchanged | rerouted | recovered | no_path
    path: PathResult | None = None
    reason: str = ""
    before_cost: float | None = None


def _health(state: State, lid: str) -> str:
    return state.link_health.get(lid, {}).get("health", "healthy")


def _name(path: PathResult | None) -> str:
    return "-".join(path.nodes) if path else "none"


class Engine:
    """Reacts to health changes, never to metric jitter, so it cannot flap on noise."""

    def __init__(self) -> None:
        self._noted: tuple | None = None   # degraded path already reported as "no better path"
        self._critical = False             # CRITICAL "no path" already reported

    def reconcile(self, state: State, topology: Topology) -> None:
        """Run once per tick after the detector."""
        with state.lock:
            cur = state.healing_path
            if cur is None:
                self._try_recover(state, topology)
                return
            reason = self._problem(state, cur)
            if reason:
                self._handle_problem(state, topology, cur, reason)
            else:
                self._noted = None
                self._maybe_failback(state, cur)

    @staticmethod
    def _problem(state: State, path: PathResult) -> str | None:
        """Why the active path must change, or None."""
        if set(path.nodes) & state.dead_nodes:
            return "node failure"
        health = [_health(state, l) for l in path.links]
        if "down" in health:
            return "link failure"
        if "degraded" in health:
            return "degradation"
        return None

    def _handle_problem(self, state, topology, cur, reason) -> None:
        new = compute_healing_path(topology, state.link_health, state.dead_nodes, state.ewma)
        if new is None:
            state.healing_path = None
            if not self._critical:
                self._critical = True
                state.log_event("CRITICAL", "No path from source to destination, healing flow is down",
                                "critical")
        elif new.nodes != cur.nodes:
            self._install(state, new, "reroute", reason)
        elif self._noted != tuple(cur.links):
            self._noted = tuple(cur.links)
            state.log_event("WARN", "No better path, staying on degraded route")

    def _try_recover(self, state: State, topology: Topology) -> None:
        new = compute_healing_path(topology, state.link_health, state.dead_nodes, state.ewma)
        if new is not None:
            self._install(state, new, "recovery", "path available again")

    def _maybe_failback(self, state: State, cur: PathResult) -> None:
        pref = state.baseline_path
        if not has_path(pref) or cur.nodes == pref.nodes:
            return
        links_ok = all(_health(state, l) == "healthy" for l in pref.links)
        nodes_ok = not set(pref.nodes) & state.dead_nodes
        if links_ok and nodes_ok and state.tick - state.last_route_change_tick >= HOLD_DOWN_TICKS:
            self._install(state, pref, "failback", "preferred path recovered")

    def decide_topology_change(self, state: State, topology: Topology, diff: TopologyDiff) -> Decision:
        """Pure: how should the healing route react to this edit? Planned edits ignore the hold-down."""
        cur = state.healing_path
        cand = compute_healing_path(topology, state.link_health, state.dead_nodes, state.ewma)
        if cur is None:
            return Decision("recovered", cand, "topology change") if cand else Decision("no_path")
        before = path_cost(topology, cur, state.link_health, state.ewma)
        before = cur.cost if before == float("inf") else before
        why = self._topology_problem(state, cur, diff)
        if why:
            if cand is None:
                return Decision("no_path", None, why, before)
            if cand.nodes != cur.nodes:
                return Decision("rerouted", cand, why, before)
            return Decision("unchanged", None, why, before)
        if cand is not None and cand.nodes != cur.nodes and cand.cost <= before - max(1.0, 0.05 * before):
            return Decision("rerouted", cand, "better route after topology change", before)
        return Decision("unchanged", None, "", before)

    def on_topology_change(self, state: State, topology: Topology, diff: TopologyDiff, tick: int) -> Decision:
        """Called by the simulation right after a planned edit; reroutes in the same tick, no detection delay."""
        with state.lock:
            d = self.decide_topology_change(state, topology, diff)
            self._noted = None
            if d.result == "recovered":
                self._install(state, d.path, "recovery", "topology change")
            elif d.result == "rerouted":
                self._install(state, d.path, "reroute", d.reason)
            elif d.result == "no_path":
                state.healing_path = None
                if not self._critical:
                    self._critical = True
                    state.log_event("CRITICAL", "No path from source to destination, healing flow is down",
                                    "critical")
            return d

    def _topology_problem(self, state: State, path: PathResult, diff: TopologyDiff) -> str | None:
        """Why the active path must change after an edit, or None."""
        gone = [l for l in path.links if l in diff.removed_links]
        if gone:
            return f"topology change: link {gone[0]} removed"
        gone_nodes = [n for n in path.nodes if n in diff.removed_nodes]
        if gone_nodes:
            return f"topology change: router {gone_nodes[0]} removed"
        if diff.endpoints_changed and not has_path(path):
            return "topology change: endpoints changed"
        reason = self._problem(state, path)
        return f"topology change: {reason}" if reason else None

    def _install(self, state: State, new: PathResult, kind: str, reason: str) -> None:
        old = state.healing_path
        state.healing_path = new
        state.last_route_change_tick = state.tick
        self._noted = None
        self._critical = False
        cost = round(new.cost, 1)
        state.route_changes.append({"tick": state.tick, "kind": kind, "from": _name(old),
                                    "to": _name(new), "cost": cost, "reason": reason})
        state.log_event(kind.upper(), f"{kind.upper()} {_name(old)} -> {_name(new)} ({reason}, cost {cost:g})",
                        "failback" if kind == "failback" else "reroute")
