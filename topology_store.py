"""Saving, loading, importing and exporting topologies (the `topologies/` folder)."""
from __future__ import annotations

import json
import os
import re

from topology import Topology, TopologyError, load_topology, topology_from_dict

ROOT = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(ROOT, "topologies")   # shipped presets live here
TOPO_DIR = PRESET_DIR                              # user saves and the autosave go here
DEFAULT_FILE = os.path.join(ROOT, "topology.json")
PRESETS = ("small_ring", "grid_3x3")
AUTOSAVE = "_autosave"
_NAME = re.compile(r"[A-Za-z0-9_-]{1,40}")


def check_name(name) -> str:
    """Only plain names are allowed, so no path can escape the folder."""
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise TopologyError("name", "name must be 1-40 letters, digits, '_' or '-'")
    return name


def _path(name: str) -> str:
    return os.path.join(PRESET_DIR if name in PRESETS else TOPO_DIR, f"{name}.json")


def list_topologies() -> list[dict]:
    """Default, shipped presets and user-saved topologies."""
    out = [{"name": "default", "kind": "default"}]
    out += [{"name": p, "kind": "preset"} for p in PRESETS if os.path.isfile(_path(p))]
    if os.path.isdir(TOPO_DIR):
        for f in sorted(os.listdir(TOPO_DIR)):
            name = f[:-5] if f.endswith(".json") else ""
            if name and name not in PRESETS and not name.startswith("_") and _NAME.fullmatch(name):
                out.append({"name": name, "kind": "saved"})
    return out


def load(name: str) -> Topology:
    """Load `default`, a preset or a saved topology by name."""
    check_name(name)
    if name == "default":
        return load_topology(DEFAULT_FILE)
    path = _path(name)
    if not os.path.isfile(path):
        raise KeyError(f"unknown topology: {name}")
    with open(path) as f:
        return topology_from_dict(json.load(f), name=name)


def save(name: str, topology: Topology) -> None:
    """Save under a new or existing user name (presets and 'default' are protected)."""
    check_name(name)
    if name == "default" or name in PRESETS or name.startswith("_"):
        raise TopologyError("name", f"'{name}' is reserved, choose another name")
    _write(_path(name), topology, name)


def export_json(topology: Topology) -> str:
    """The saved-file format as text (download)."""
    return json.dumps(_file_dict(topology, topology.name), indent=2)


def import_json(text: str) -> Topology:
    """Parse an uploaded file. Structural validation only: a disconnected graph is allowed."""
    try:
        raw = json.loads(text)
    except ValueError as e:
        raise TopologyError("file", f"not valid JSON: {e}") from e
    if not isinstance(raw, dict):
        raise TopologyError("file", "expected a JSON object")
    name = raw.get("name")
    name = name if isinstance(name, str) and _NAME.fullmatch(name) else "imported"
    return topology_from_dict(raw, name=name)


def autosave(topology: Topology) -> None:
    """Write the working copy after every edit. Never raises."""
    try:
        _write(_path(AUTOSAVE), topology, topology.name)
    except OSError as e:
        print(f"autosave failed: {e}")


def _file_dict(t: Topology, name: str) -> dict:
    d = t.to_dict()
    d["name"] = name
    d.pop("version"), d.pop("layout_version")
    return d


def _write(path: str, t: Topology, name: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(_file_dict(t, name), f, indent=2)
