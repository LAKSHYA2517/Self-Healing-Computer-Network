"""Self-healing controller: reroute around detected faults and fail back with hold-down."""
from config import HOLD_DOWN_TICKS
from routing import PathResult, compute_healing_path
from state import State
from topology import Topology


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
        health = [state.link_health[l]["health"] for l in path.links]
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
                state.log_event("CRITICAL", "No path from source to destination, healing flow is down")
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
        pref = state.static_path
        if cur.nodes == pref.nodes:
            return
        links_ok = all(state.link_health[l]["health"] == "healthy" for l in pref.links)
        nodes_ok = not set(pref.nodes) & state.dead_nodes
        if links_ok and nodes_ok and state.tick - state.last_route_change_tick >= HOLD_DOWN_TICKS:
            self._install(state, pref, "failback", "preferred path recovered")

    def _install(self, state: State, new: PathResult, kind: str, reason: str) -> None:
        old = state.healing_path
        state.healing_path = new
        state.last_route_change_tick = state.tick
        self._noted = None
        self._critical = False
        cost = round(new.cost, 1)
        state.route_changes.append({"tick": state.tick, "kind": kind, "from": _name(old),
                                    "to": _name(new), "cost": cost, "reason": reason})
        state.log_event(kind.upper(), f"{kind.upper()} {_name(old)} -> {_name(new)} ({reason}, cost {cost:g})")
