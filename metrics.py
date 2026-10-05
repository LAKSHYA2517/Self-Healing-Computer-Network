"""Minimal CSV metrics logger."""
import csv
import os

PATH = os.path.join("logs", "metrics.csv")
HEADER = ["timestamp", "link_id", "status", "latency_ms", "loss_pct", "util_pct", "route_status"]
_failed = False


def log_tick(ts: float, link_metrics: dict, route_status: str, path: str = PATH) -> None:
    """Append one row per link. Never raises: I/O errors are reported once."""
    global _failed
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        new = not os.path.exists(path)
        with open(path, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(HEADER)
            for lid, m in link_metrics.items():
                lat = "" if m["latency_ms"] is None else round(m["latency_ms"], 2)
                w.writerow([round(ts, 3), lid, m["status"], lat,
                            round(m["loss_pct"], 2), round(m["util_pct"], 1), route_status])
            f.flush()
    except OSError as e:
        if not _failed:
            print(f"metrics logging disabled: {e}")
            _failed = True
