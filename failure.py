"""Manual failure and impairment injection (ground truth for the simulation)."""
from state import State

_NO_IMPAIRMENT = {"loss_pct": 0.0, "util_pct": None, "latency_mult": 1.0}


def _route_name(state: State) -> str:
    return "-".join(state.baseline_path.nodes)


def _check(state: State, kind: str, ident: str) -> None:
    table = state.topology.links if kind == "link" else state.topology.nodes
    if ident not in table:
        raise KeyError(f"unknown {kind} id: {ident}")


def _label(state: State, kind: str, ident: str) -> str:
    if kind == "link":
        l = state.topology.links[ident]
        return f"Link {ident} ({l.a}-{l.b})"
    return f"Node {ident}"


def _log_fault(state: State, op: str, ident: str, text: str) -> None:
    state.fault_log.append({"tick": state.tick, "op": op, "target": ident, "id": ident,
                            "restored_tick": None, "description": text})


def _close_faults(state: State, ident: str, ops: tuple[str, ...]) -> None:
    """Mark open faults on `ident` with the given ops as restored now."""
    for f in state.fault_log:
        if f["target"] == ident and f["op"] in ops and f["restored_tick"] is None:
            f["restored_tick"] = state.tick


def _set(state: State, kind: str, ident: str, failed: bool) -> None:
    """Fail or restore one element; idempotent. Logs route status transitions."""
    _check(state, kind, ident)
    with state.lock:
        target = state.failed_links if kind == "link" else state.failed_nodes
        if (ident in target) == failed:
            return
        before = state.route_status()
        (target.add if failed else target.discard)(ident)
        text = f"{_label(state, kind, ident)} {'FAILED' if failed else 'RESTORED'}"
        state.log_event("INFO", text, "fault" if failed else "restore")
        if failed:
            _log_fault(state, f"fail_{kind}", ident, text)
        else:
            _close_faults(state, ident, (f"fail_{kind}",))
        after = state.route_status()
        if before != after:
            if after == "BROKEN":
                state.log_event("WARN", f"Baseline route {_route_name(state)} is BROKEN")
            else:
                state.log_event("INFO", f"Baseline route {_route_name(state)} is OK again")


def _set_impairment(state: State, link_id: str, **changes) -> str | None:
    """Merge changes into a link's impairment; returns the description, or None if nothing changed."""
    _check(state, "link", link_id)
    cur = state.impairments.get(link_id, _NO_IMPAIRMENT)
    new = {**cur, **changes}
    if new == cur:
        return None
    state.impairments[link_id] = new
    return _label(state, "link", link_id)


def degrade_link(state: State, link_id: str, loss_pct: float, latency_mult: float = 1.0) -> None:
    """Add packet loss (and optionally latency) to a link that stays up."""
    if not 0 <= loss_pct <= 100 or latency_mult <= 0:
        raise ValueError("loss_pct must be 0-100 and latency_mult > 0")
    with state.lock:
        label = _set_impairment(state, link_id, loss_pct=float(loss_pct), latency_mult=float(latency_mult))
        if label:
            text = f"{label} DEGRADED (loss {loss_pct:g}%, latency x{latency_mult:g})"
            state.log_event("WARN", text, "fault")
            _log_fault(state, "degrade_link", link_id, text)


def congest_link(state: State, link_id: str, util_pct: float) -> None:
    """Force a link's utilization; above 90% it also drops packets."""
    if not 0 <= util_pct <= 100:
        raise ValueError("util_pct must be 0-100")
    with state.lock:
        label = _set_impairment(state, link_id, util_pct=float(util_pct))
        if label:
            text = f"{label} CONGESTED (util {util_pct:g}%)"
            state.log_event("WARN", text, "fault")
            _log_fault(state, "congest_link", link_id, text)


def clear_link(state: State, link_id: str) -> None:
    """Remove a link's impairments only (not a hard failure)."""
    _check(state, "link", link_id)
    with state.lock:
        if state.impairments.pop(link_id, None) is not None:
            _close_faults(state, link_id, ("degrade_link", "congest_link"))
            state.log_event("INFO", f"{_label(state, 'link', link_id)} impairment CLEARED", "restore")


def fail_link(state: State, link_id: str) -> None:
    _set(state, "link", link_id, True)


def restore_link(state: State, link_id: str) -> None:
    """Bring a link back: clears its failure and its impairments."""
    clear_link(state, link_id)
    _set(state, "link", link_id, False)


def fail_node(state: State, node_id: str) -> None:
    _set(state, "node", node_id, True)


def restore_node(state: State, node_id: str) -> None:
    _set(state, "node", node_id, False)


def reset(state: State) -> None:
    """Clear everything: failures, impairments, health, routes, series, tick, events."""
    with state.lock:
        state.reset_run()
        state.log_event("INFO", "Reset: all failures cleared")
