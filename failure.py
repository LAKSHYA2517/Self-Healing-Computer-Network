"""Manual failure injection."""
from state import State


def _route_name(state: State) -> str:
    return "-".join(state.baseline_path.nodes)


def _check(state: State, kind: str, ident: str) -> None:
    table = state.topology.links if kind == "link" else state.topology.nodes
    if ident not in table:
        raise KeyError(f"unknown {kind} id: {ident}")


def _set(state: State, kind: str, ident: str, failed: bool) -> None:
    """Fail or restore one element; idempotent. Logs route status transitions."""
    _check(state, kind, ident)
    with state.lock:
        target = state.failed_links if kind == "link" else state.failed_nodes
        if (ident in target) == failed:
            return
        before = state.route_status()
        (target.add if failed else target.discard)(ident)
        label = ident
        if kind == "link":
            l = state.topology.links[ident]
            label = f"{ident} ({l.a}-{l.b})"
        state.log_event("INFO", f"{kind.capitalize()} {label} {'FAILED' if failed else 'RESTORED'}")
        after = state.route_status()
        if before != after:
            if after == "BROKEN":
                state.log_event("WARN", f"Baseline route {_route_name(state)} is BROKEN")
            else:
                state.log_event("INFO", f"Baseline route {_route_name(state)} is OK again")


def fail_link(state: State, link_id: str) -> None:
    _set(state, "link", link_id, True)


def restore_link(state: State, link_id: str) -> None:
    _set(state, "link", link_id, False)


def fail_node(state: State, node_id: str) -> None:
    _set(state, "node", node_id, True)


def restore_node(state: State, node_id: str) -> None:
    _set(state, "node", node_id, False)


def reset(state: State) -> None:
    """Clear all failures and recompute the baseline path."""
    with state.lock:
        broken = state.route_status() == "BROKEN"
        state.failed_links.clear()
        state.failed_nodes.clear()
        state.baseline_path = state.compute_baseline()
        state.log_event("INFO", "Reset: all failures cleared")
        if broken:
            state.log_event("INFO", f"Baseline route {_route_name(state)} is OK again")
