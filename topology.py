"""Immutable topology model, validated edit functions and JSON loading.

Every edit is a pure function that returns a new Topology; nothing is mutated in place.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Mapping

import networkx as nx

LIMITS = {
    "max_nodes": 30, "max_links": 80,
    "latency": (1, 500), "bw": (1, 10000), "x": (0, 1000), "y": (0, 600),
}


class TopologyError(ValueError):
    """A rejected edit: `field` names the offending input, the message is for humans."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field


class UnknownElement(TopologyError):
    """An id in the URL that does not exist (HTTP 404)."""


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


def _next_counter(ids, prefix: str) -> int:
    nums = [int(i[len(prefix):]) for i in ids if re.fullmatch(rf"{prefix}\d+", i)]
    return max(nums, default=0) + 1


@dataclass(frozen=True)
class Topology:
    nodes: Mapping[str, Node]
    links: Mapping[str, Link]
    source: str
    destination: str
    name: str = "default"
    next_node: int = 0
    next_link: int = 0
    version: int = 0
    layout_version: int = 0

    def __post_init__(self) -> None:
        # frozen dataclass: freeze the containers and derive missing id counters
        object.__setattr__(self, "nodes", MappingProxyType(dict(self.nodes)))
        object.__setattr__(self, "links", MappingProxyType(dict(self.links)))
        if self.next_node <= 0:
            object.__setattr__(self, "next_node", _next_counter(self.nodes, "R"))
        if self.next_link <= 0:
            object.__setattr__(self, "next_link", _next_counter(self.links, "L"))

    def to_dict(self) -> dict:
        """JSON-serializable view (also the saved-file format)."""
        return {
            "name": self.name,
            "nodes": [vars(n) for n in self.nodes.values()],
            "links": [vars(l) for l in self.links.values()],
            "source": self.source,
            "destination": self.destination,
            "next_node": self.next_node,
            "next_link": self.next_link,
            "version": self.version,
            "layout_version": self.layout_version,
        }

    def content_signature(self) -> str:
        """Canonical text of what the user sees (ignores counters and versions), for the dirty flag."""
        return json.dumps({
            "nodes": sorted((n.id, n.x, n.y) for n in self.nodes.values()),
            "links": sorted((l.id, l.a, l.b, l.latency, l.bw) for l in self.links.values()),
            "source": self.source, "destination": self.destination,
        })


@dataclass(frozen=True)
class TopologyDiff:
    """What changed between two topologies, as ids."""
    added_links: tuple[str, ...] = ()
    removed_links: tuple[str, ...] = ()
    changed_links: Mapping[str, tuple[float, float]] = field(default_factory=dict)  # id -> (old, new) latency
    bw_changed: tuple[str, ...] = ()
    added_nodes: tuple[str, ...] = ()
    removed_nodes: tuple[str, ...] = ()
    endpoints_changed: bool = False
    moved_nodes: tuple[str, ...] = ()

    @property
    def structural(self) -> bool:
        """Anything that can change routing (everything except pure moves)."""
        return bool(self.added_links or self.removed_links or self.changed_links or self.bw_changed
                    or self.added_nodes or self.removed_nodes or self.endpoints_changed)


def diff_topologies(old: Topology, new: Topology) -> TopologyDiff:
    """Compare two topologies. A link whose endpoints changed counts as removed plus added."""
    same = {i for i in old.links if i in new.links
            and (old.links[i].a, old.links[i].b) == (new.links[i].a, new.links[i].b)}
    return TopologyDiff(
        added_links=tuple(i for i in new.links if i not in same),
        removed_links=tuple(i for i in old.links if i not in same),
        changed_links={i: (old.links[i].latency, new.links[i].latency)
                       for i in same if old.links[i].latency != new.links[i].latency},
        bw_changed=tuple(i for i in same if old.links[i].bw != new.links[i].bw),
        added_nodes=tuple(i for i in new.nodes if i not in old.nodes),
        removed_nodes=tuple(i for i in old.nodes if i not in new.nodes),
        endpoints_changed=(old.source, old.destination) != (new.source, new.destination),
        moved_nodes=tuple(i for i in new.nodes if i in old.nodes
                          and (old.nodes[i].x, old.nodes[i].y) != (new.nodes[i].x, new.nodes[i].y)),
    )


# ---------------------------------------------------------------- validation helpers

def _number(value, name: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TopologyError(name, f"{name} must be a number")
    if not lo <= value <= hi:
        raise TopologyError(name, f"{name} must be between {lo:g} and {hi:g}")
    return value


def _coords(x, y) -> tuple[int, int]:
    return (round(_number(x, "x", *LIMITS["x"])), round(_number(y, "y", *LIMITS["y"])))


def _latency(v) -> float:
    return _number(v, "latency", *LIMITS["latency"])


def _bandwidth(v) -> float:
    return _number(v, "bw", *LIMITS["bw"])


def _need_node(t: Topology, node_id, field_name: str = "id") -> None:
    if not isinstance(node_id, str) or node_id not in t.nodes:
        raise (UnknownElement if field_name == "id" else TopologyError)(field_name, f"unknown router: {node_id}")


def _pair_link(t: Topology, a: str, b: str) -> Link | None:
    return next((l for l in t.links.values() if {l.a, l.b} == {a, b}), None)


def _bump(t: Topology, **changes) -> Topology:
    return replace(t, version=t.version + 1, **changes)


# ---------------------------------------------------------------- edit functions

def add_node(t: Topology, x, y) -> Topology:
    """Add a router at (x, y); the id comes from the monotonic counter."""
    if len(t.nodes) >= LIMITS["max_nodes"]:
        raise TopologyError("nodes", f"at most {LIMITS['max_nodes']} routers are allowed")
    px, py = _coords(x, y)
    node = Node(f"R{t.next_node}", px, py)
    return _bump(t, nodes={**t.nodes, node.id: node}, next_node=t.next_node + 1)


def move_node(t: Topology, node_id: str, x, y) -> Topology:
    """Move a router. Only the layout version changes (routing is unaffected)."""
    _need_node(t, node_id)
    px, py = _coords(x, y)
    return replace(t, nodes={**t.nodes, node_id: Node(node_id, px, py)}, layout_version=t.layout_version + 1)


def remove_node(t: Topology, node_id: str) -> tuple[Topology, list[str]]:
    """Delete a router and every link touching it. Returns the new topology and removed link ids."""
    _need_node(t, node_id)
    if node_id == t.source:
        raise TopologyError("id", f"{node_id} is the source. Choose another source first")
    if node_id == t.destination:
        raise TopologyError("id", f"{node_id} is the destination. Choose another destination first")
    gone = [l.id for l in t.links.values() if node_id in (l.a, l.b)]
    nodes = {k: v for k, v in t.nodes.items() if k != node_id}
    links = {k: v for k, v in t.links.items() if k not in gone}
    return _bump(t, nodes=nodes, links=links), gone


def add_link(t: Topology, a, b, latency, bw=100) -> Topology:
    """Connect two routers. Rejects self-loops and a second link between the same pair."""
    _need_node(t, a, "a")
    _need_node(t, b, "b")
    if a == b:
        raise TopologyError("b", "a link needs two different routers")
    existing = _pair_link(t, a, b)
    if existing:
        raise TopologyError("b", f"{existing.id} already connects {existing.a} and {existing.b}")
    if len(t.links) >= LIMITS["max_links"]:
        raise TopologyError("links", f"at most {LIMITS['max_links']} links are allowed")
    link = Link(f"L{t.next_link}", a, b, _latency(latency), _bandwidth(bw))
    return _bump(t, links={**t.links, link.id: link}, next_link=t.next_link + 1)


def _need_link(t: Topology, link_id) -> Link:
    if not isinstance(link_id, str) or link_id not in t.links:
        raise UnknownElement("id", f"unknown link: {link_id}")
    return t.links[link_id]


def update_link(t: Topology, link_id: str, latency=None, bw=None) -> Topology:
    """Change a link's latency and/or bandwidth."""
    old = _need_link(t, link_id)
    new = replace(old, latency=old.latency if latency is None else _latency(latency),
                  bw=old.bw if bw is None else _bandwidth(bw))
    return _bump(t, links={**t.links, link_id: new})


def remove_link(t: Topology, link_id: str) -> Topology:
    _need_link(t, link_id)
    return _bump(t, links={k: v for k, v in t.links.items() if k != link_id})


def set_endpoints(t: Topology, source, destination) -> Topology:
    """Choose which routers the two flows run between."""
    _need_node(t, source, "source")
    _need_node(t, destination, "destination")
    if source == destination:
        raise TopologyError("destination", "source and destination must be different routers")
    return _bump(t, source=source, destination=destination)


def default_latency(a_pos, b_pos) -> int:
    """Prefilled latency for a new link: distance / 25 ms, at least 1 (round half up, same as the UI)."""
    d = math.hypot(a_pos[0] - b_pos[0], a_pos[1] - b_pos[1])
    return max(1, math.floor(d / 25 + 0.5))


def warnings(t: Topology) -> list[str]:
    """Non-blocking problems: isolated routers and an unreachable destination."""
    out = [f"{n} has no links" for n in t.nodes
           if not any(n in (l.a, l.b) for l in t.links.values())]
    g = to_networkx(t)
    if t.source in g and t.destination in g and not nx.has_path(g, t.source, t.destination):
        out.append(f"No route from {t.source} to {t.destination}")
    return out


# ---------------------------------------------------------------- loading

def topology_from_dict(raw: dict, name: str | None = None, require_connected: bool = False) -> Topology:
    """Build a Topology from file/JSON data, validating structure and ranges."""
    try:
        node_list = [Node(id=n["id"], x=round(n["x"]), y=round(n["y"])) for n in raw["nodes"]]
        link_list = [Link(id=l["id"], a=l["a"], b=l["b"], latency=l["latency"], bw=l["bw"]) for l in raw["links"]]
        source, destination = raw["source"], raw["destination"]
    except (KeyError, TypeError, ValueError) as e:
        raise TopologyError("file", f"invalid topology data: {e!r}") from e
    nodes = {n.id: n for n in node_list}
    links = {l.id: l for l in link_list}
    if len(nodes) != len(node_list):
        raise TopologyError("nodes", "duplicate router ids")
    if len(links) != len(link_list):
        raise TopologyError("links", "duplicate link ids")
    if len(nodes) > LIMITS["max_nodes"] or len(links) > LIMITS["max_links"]:
        raise TopologyError("limits", f"at most {LIMITS['max_nodes']} routers and {LIMITS['max_links']} links")
    for n in node_list:
        _coords(n.x, n.y)
    seen: set[frozenset] = set()
    for l in link_list:
        if l.a not in nodes or l.b not in nodes:
            raise TopologyError("links", f"link {l.id} references an unknown router")
        if l.a == l.b:
            raise TopologyError("links", f"link {l.id} connects {l.a} to itself")
        pair = frozenset((l.a, l.b))
        if pair in seen:
            raise TopologyError("links", f"more than one link between {l.a} and {l.b}")
        seen.add(pair)
        _latency(l.latency)
        _bandwidth(l.bw)
    if source not in nodes or destination not in nodes:
        raise TopologyError("source", "source/destination not in routers")
    if source == destination:
        raise TopologyError("destination", "source and destination must be different routers")
    topo = Topology(nodes, links, source, destination, name=name or raw.get("name") or "default",
                    next_node=int(raw.get("next_node", 0) or 0), next_link=int(raw.get("next_link", 0) or 0))
    # counters must be above every existing id so ids are never reused
    topo = replace(topo, next_node=max(topo.next_node, _next_counter(nodes, "R")),
                   next_link=max(topo.next_link, _next_counter(links, "L")))
    if require_connected and not nx.is_connected(to_networkx(topo)):
        raise TopologyError("file", "topology is not connected")
    return topo


def load_topology(path: str = "topology.json") -> Topology:
    """Load a topology file that must be connected. Raises ValueError if invalid."""
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ValueError(f"invalid topology file {path}: {e!r}") from e
    try:
        return topology_from_dict(raw, name=raw.get("name", "default"), require_connected=True)
    except ValueError as e:
        raise ValueError(f"invalid topology file {path}: {e}") from e


def to_networkx(topology: Topology, exclude_links=(), exclude_nodes=()) -> nx.Graph:
    """Build a graph, skipping excluded links and links touching excluded nodes."""
    g = nx.Graph()
    g.add_nodes_from(n for n in topology.nodes if n not in exclude_nodes)
    for l in topology.links.values():
        if l.id in exclude_links or l.a in exclude_nodes or l.b in exclude_nodes:
            continue
        g.add_edge(l.a, l.b, link_id=l.id, latency=l.latency, bw=l.bw)
    return g
