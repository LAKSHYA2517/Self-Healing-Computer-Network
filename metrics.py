"""CSV logging and run summary computation."""
import csv
import io
import os

PATH = os.path.join("logs", "metrics.csv")
FLOWS_PATH = os.path.join("logs", "flows.csv")
HEADER = ["timestamp", "link_id", "status", "latency_ms", "loss_pct", "util_pct", "route_status"]
FLOWS_HEADER = ["tick", "flow", "path", "delivery_pct", "delay_ms", "throughput_mbps",
                "lost_packets", "available"]
_failed = False


def flow_row(r: dict) -> list:
    """A flow row as CSV fields."""
    return [r["tick"], r["flow"], "-".join(r["path"]) if r["path"] else "",
            r["delivery_pct"], "" if r["delay_ms"] is None else r["delay_ms"],
            r["throughput_mbps"], r["lost_packets"], int(r["available"])]


def _append(path: str, header: list, rows: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with open(path, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(header)
        w.writerows(rows)
        f.flush()


def log_tick(ts: float, link_metrics: dict, route_status: str, flow_rows=(),
             path: str = PATH, flows_path: str = FLOWS_PATH) -> None:
    """Append link rows to metrics.csv and flow rows to flows.csv. Never raises: I/O errors reported once."""
    global _failed
    try:
        links = []
        for lid, m in link_metrics.items():
            lat = "" if m["latency_ms"] is None else round(m["latency_ms"], 2)
            links.append([round(ts, 3), lid, m["status"], lat,
                          round(m["loss_pct"], 2), round(m["util_pct"], 1), route_status])
        _append(path, HEADER, links)
        if flow_rows:
            _append(flows_path, FLOWS_HEADER, [flow_row(r) for r in flow_rows])
    except OSError as e:
        if not _failed:
            print(f"metrics logging disabled: {e}")
            _failed = True


def rows_to_csv(rows) -> str:
    """Per-tick flow rows as CSV text."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(FLOWS_HEADER)
    w.writerows(flow_row(r) for r in rows)
    return out.getvalue()


def _fault_table(state) -> list[dict]:
    """Per injected fault: detection tick and healing recovery time (ground truth used here only)."""
    faults = state.fault_log
    reroutes = [r for r in state.route_changes if r["kind"] == "reroute"]
    recovered: dict[int, int] = {}
    for r in reroutes:
        owner = max((i for i, f in enumerate(faults) if f["tick"] <= r["tick"]), default=None)
        if owner is not None and owner not in recovered:
            recovered[owner] = r["tick"]
    table = []
    for i, f in enumerate(faults):
        det = next((d["tick"] for d in state.detections if d["tick"] >= f["tick"]), None)
        rer = recovered.get(i)
        table.append({"fault": f["description"], "fault_tick": f["tick"],
                      "detected_tick": det,
                      "detection_ticks": None if det is None else det - f["tick"] + 1,
                      "reroute_tick": rer,
                      "recovery_ticks": None if rer is None else rer - f["tick"] + 1})
    return table


def compute_summary(state) -> dict:
    """Per-flow totals for the current run; healing also carries per-fault detection/recovery."""
    out: dict = {"ticks": state.tick}
    for flow, t in state.flow_totals.items():
        n, sent = t["ticks"], t["sent"]
        out[flow] = {
            "sent": sent, "lost": t["lost"],
            "loss_pct": round(100 * t["lost"] / sent, 2) if sent else 0.0,
            "outage_ticks": t["outage_ticks"],
            "availability_pct": round(100 * (n - t["outage_ticks"]) / n, 2) if n else 100.0,
            "route_changes": len(state.route_changes) if flow == "healing" else 0,
            "avg_delay_ms": round(t["delay_sum"] / t["delay_n"], 2) if t["delay_n"] else None,
            "avg_throughput_mbps": round(t["thr_sum"] / n, 2) if n else 0.0,
        }
    out["healing"]["faults"] = _fault_table(state)
    out["topology_edited"] = bool(state.scenario.get("edited"))
    return out


def write_summary_csv(summary: dict, path: str) -> None:
    """One row per flow; healing detection/recovery ticks are ';'-joined per fault."""
    cols = ["sent", "lost", "loss_pct", "outage_ticks", "availability_pct", "route_changes",
            "avg_delay_ms", "avg_throughput_mbps"]
    faults = summary["healing"]["faults"]
    join = lambda key: ";".join("" if f[key] is None else str(f[key]) for f in faults)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["flow"] + cols + ["detection_ticks", "recovery_ticks"])
        for flow in ("static", "healing"):
            s = summary[flow]
            extra = [join("detection_ticks"), join("recovery_ticks")] if flow == "healing" else ["", ""]
            w.writerow([flow] + [s[c] for c in cols] + extra)
