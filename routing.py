"""Shortest-path computation (Dijkstra via NetworkX)."""
from __future__ import annotations

from dataclasses import dataclass

import networkx as nx

from topology import Topology, to_networkx


@dataclass(frozen=True)
class PathResult:
    nodes: list[str]
    links: list[str]
    cost: float


def _live_weight(link_id: str, latency: float, live_metrics: dict) -> float:
    m = live_metrics[link_id]
    return latency + 2 * m["loss_pct"] + 0.1 * m["util_pct"]


def compute_path(topology: Topology, src: str, dst: str, failed_links=(), failed_nodes=(),
                 cost_mode: str = "static", live_metrics: dict | None = None) -> PathResult | None:
    """Cheapest src->dst path avoiding failed elements, or None if unreachable."""
    if cost_mode not in ("static", "live"):
        raise ValueError(f"unknown cost_mode {cost_mode!r}")
    if cost_mode == "live" and live_metrics is None:
        raise ValueError("live cost_mode requires live_metrics")
    g = to_networkx(topology, failed_links, failed_nodes)
    if src not in g or dst not in g:
        return None
    for _, _, d in g.edges(data=True):
        d["weight"] = (d["latency"] if cost_mode == "static"
                       else _live_weight(d["link_id"], d["latency"], live_metrics))
    try:
        nodes = nx.dijkstra_path(g, src, dst, weight="weight")
    except nx.NetworkXNoPath:
        return None
    edges = list(zip(nodes, nodes[1:]))
    return PathResult(nodes, [g.edges[e]["link_id"] for e in edges],
                      sum(g.edges[e]["weight"] for e in edges))


def path_is_intact(path: PathResult, failed_links, failed_nodes) -> bool:
    """False if the path uses a failed link or passes through a failed node."""
    return not (set(path.links) & set(failed_links) or set(path.nodes) & set(failed_nodes))
