"""Two flows (static vs self-healing) evaluated on each tick's samples."""
import math

from config import AVAILABLE_DELIVERY, PACKETS_PER_TICK
from routing import PathResult
from state import FLOWS, State
from topology import Topology


def evaluate(topology: Topology, path: PathResult | None, link_metrics: dict) -> dict:
    """Delivery, loss, delay and throughput of PACKETS_PER_TICK packets over `path` this tick."""
    ratio = 0.0
    if path is not None and path.links:
        # a link with no metrics no longer exists (planned removal): it counts as down
        ms = [link_metrics.get(l) for l in path.links]
        if all(m is not None and m["status"] != "down" for m in ms):
            ratio = math.prod(1 - m["loss_pct"] / 100 for m in ms)
    delay = thr = None
    if ratio > 0:
        delay = sum(link_metrics[l]["latency_ms"] for l in path.links)
        thr = min(topology.links[l].bw * (1 - link_metrics[l]["util_pct"] / 100)
                  for l in path.links) * ratio
    return {"delivery_pct": round(ratio * 100, 2),
            "delay_ms": None if delay is None else round(delay, 2),
            "throughput_mbps": 0.0 if thr is None else round(thr, 2),
            "lost_packets": round(PACKETS_PER_TICK * (1 - ratio)),
            "available": ratio >= AVAILABLE_DELIVERY}


def step(state: State, topology: Topology) -> None:
    """Evaluate both flows on the current paths and record rows and running totals."""
    paths = {"static": state.static_path, "healing": state.healing_path}
    for flow in FLOWS:
        path = paths[flow]
        row = {"tick": state.tick, "flow": flow, "path": path.nodes if path and path.nodes else None,
               **evaluate(topology, path, state.link_metrics)}
        state.series[flow].append(row)
        state.rows.append(row)
        t = state.flow_totals[flow]
        t["ticks"] += 1
        t["sent"] += PACKETS_PER_TICK
        t["lost"] += row["lost_packets"]
        t["outage_ticks"] += not row["available"]
        t["thr_sum"] += row["throughput_mbps"]
        if row["delay_ms"] is not None:
            t["delay_sum"] += row["delay_ms"]
            t["delay_n"] += 1
