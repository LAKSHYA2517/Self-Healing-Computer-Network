"""Shortest-path computation (Dijkstra via NetworkX)."""
from __future__ import annotations

from dataclasses import dataclass

import networkx as nx

from config import DEGRADED_PENALTY
from topology import Topology, to_networkx


@dataclass(frozen=True)
class PathResult:
    nodes: list[str]
    links: list[str]
    cost: float


def live_cost(base: float, m: dict | None, health: str = "healthy") -> float:
    """Link cost from smoothed metrics and detected health; equals `base` under normal jitter."""
    m = m or {}
    latency = m.get("latency_ms") or base
    return (base
            + max(0.0, latency - 1.3 * base)
            + 2.0 * max(0.0, m.get("loss_pct", 0.0) - 2.0)
            + 0.5 * max(0.0, m.get("util_pct", 0.0) - 60.0)
            + (DEGRADED_PENALTY if health == "degraded" else 0.0))


def compute_path(topology: Topology, src: str, dst: str, failed_links=(), failed_nodes=(),
                 cost_mode: str = "static", live_metrics: dict | None = None) -> PathResult | None:
    """Cheapest src->dst path avoiding failed elements, or None if unreachable.

    live_metrics[link_id] holds smoothed latency_ms/loss_pct/util_pct and optionally `health`.
    """
    if cost_mode not in ("static", "live"):
        raise ValueError(f"unknown cost_mode {cost_mode!r}")
    if cost_mode == "live" and live_metrics is None:
        raise ValueError("live cost_mode requires live_metrics")
    g = to_networkx(topology, failed_links, failed_nodes)
    if src not in g or dst not in g:
        return None
    for _, _, d in g.edges(data=True):
        if cost_mode == "static":
            d["weight"] = d["latency"]
        else:
            m = live_metrics.get(d["link_id"])
            d["weight"] = live_cost(d["latency"], m, (m or {}).get("health", "healthy"))
    try:
        nodes = nx.dijkstra_path(g, src, dst, weight="weight")
    except nx.NetworkXNoPath:
        return None
    edges = list(zip(nodes, nodes[1:]))
    return PathResult(nodes, [g.edges[e]["link_id"] for e in edges],
                      sum(g.edges[e]["weight"] for e in edges))


def compute_healing_path(topology: Topology, health: dict, dead_nodes, ewma: dict) -> PathResult | None:
    """Live-cost path that avoids links detected down and nodes inferred dead."""
    down = {lid for lid, h in health.items() if h["health"] == "down"}
    live = {lid: {**ewma.get(lid, {}), "health": h["health"]} for lid, h in health.items()}
    return compute_path(topology, topology.source, topology.destination,
                        down, dead_nodes, "live", live)


def path_is_intact(path: PathResult, failed_links, failed_nodes) -> bool:
    """False if the path uses a failed link or passes through a failed node."""
    return not (set(path.links) & set(failed_links) or set(path.nodes) & set(failed_nodes))
