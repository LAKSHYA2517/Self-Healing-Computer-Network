"""Topology model loaded from JSON."""
import json
from dataclasses import dataclass

import networkx as nx


@dataclass(frozen=True)
class Node:
    id: str
    x: int
    y: int


@dataclass(frozen=True)
class Link:
    id: str
    a: str
    b: str
    latency: float
    bw: float


@dataclass(frozen=True)
class Topology:
    nodes: dict[str, Node]
    links: dict[str, Link]
    source: str
    destination: str

    def to_dict(self) -> dict:
        """JSON-serializable view for the API."""
        return {
            "nodes": [vars(n) for n in self.nodes.values()],
            "links": [vars(l) for l in self.links.values()],
            "source": self.source,
            "destination": self.destination,
        }


def load_topology(path: str = "topology.json") -> Topology:
    """Load and validate a topology file. Raises ValueError if invalid."""
    try:
        with open(path) as f:
            raw = json.load(f)
        node_list = [Node(**n) for n in raw["nodes"]]
        link_list = [Link(**l) for l in raw["links"]]
        source, destination = raw["source"], raw["destination"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ValueError(f"invalid topology file {path}: {e!r}") from e

    nodes = {n.id: n for n in node_list}
    links = {l.id: l for l in link_list}
    if len(nodes) != len(node_list):
        raise ValueError("duplicate node ids")
    if len(links) != len(link_list):
        raise ValueError("duplicate link ids")
    for l in link_list:
        if l.a not in nodes or l.b not in nodes:
            raise ValueError(f"link {l.id} references unknown node")
    if source not in nodes or destination not in nodes:
        raise ValueError("source/destination not in nodes")

    topo = Topology(nodes, links, source, destination)
    if not nx.is_connected(to_networkx(topo)):
        raise ValueError("topology is not connected")
    return topo


def to_networkx(topology: Topology, exclude_links=(), exclude_nodes=()) -> nx.Graph:
    """Build a graph, skipping excluded links and links touching excluded nodes."""
    g = nx.Graph()
    g.add_nodes_from(n for n in topology.nodes if n not in exclude_nodes)
    for l in topology.links.values():
        if l.id in exclude_links or l.a in exclude_nodes or l.b in exclude_nodes:
            continue
        g.add_edge(l.a, l.b, link_id=l.id, latency=l.latency, bw=l.bw)
    return g
