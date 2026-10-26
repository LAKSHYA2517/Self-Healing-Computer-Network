"""One step() that runs the whole pipeline in a fixed order, plus the scenario player."""
import glob
import json
import os
import random
import threading
import time
import traceback
from collections import deque
from dataclasses import replace

import failure
import metrics
import monitor
import topology_store
import traffic
from detector import Detector
from engine import Decision, Engine
from routing import has_path, preferred_path
from state import State
from topology import (LIMITS, Topology, TopologyDiff, TopologyError, add_link, add_node, diff_topologies,
                      move_node, remove_link, remove_node, set_endpoints, update_link, warnings)

MIN_TICK_SECONDS, MAX_TICK_SECONDS = 0.25, 3.0
HISTORY_LIMIT = 50

SCENARIO_DIR = "scenarios"


class TopologyDirty(Exception):
    """The scenario needs a different topology but the current one has unsaved edits."""

OPS = {
    "fail_link": lambda s, e: failure.fail_link(s, e["id"]),
    "restore_link": lambda s, e: failure.restore_link(s, e["id"]),
    "fail_node": lambda s, e: failure.fail_node(s, e["id"]),
    "restore_node": lambda s, e: failure.restore_node(s, e["id"]),
    "degrade_link": lambda s, e: failure.degrade_link(s, e["id"], e["loss_pct"], e.get("latency_mult", 1.0)),
    "congest_link": lambda s, e: failure.congest_link(s, e["id"], e["util_pct"]),
    "clear_link": lambda s, e: failure.clear_link(s, e["id"]),
}


def list_scenarios(directory: str = SCENARIO_DIR) -> list[dict]:
    """Available scenarios as {name, title, duration}."""
    out = []
    for p in sorted(glob.glob(os.path.join(directory, "*.json"))):
        with open(p) as f:
            d = json.load(f)
        out.append({"name": d["name"], "title": d.get("title", d["name"]), "duration": d["duration"],
                    "events": d.get("events", []), "topology": d.get("topology", "default")})
    return out


def _arrow(nodes: list[str]) -> str:
    return ">".join(nodes)


def _fmt(v: float) -> str:
    return f"{v:g}"


class Simulation:
    """Owns state, monitor RNG, detector, engine, the scenario player and the topology-edit funnel."""

    def __init__(self, topology: Topology, noise: bool = True, seed: int | None = None,
                 log: bool = True):
        self.noise, self.seed, self.log = noise, seed, log
        self.state = State(topology)
        self._undo: list[tuple[Topology, str]] = []
        self._redo: list[tuple[Topology, str]] = []
        self._saved_sig: str | None = topology.content_signature()
        self._init_run()
        self._thread: threading.Thread | None = None
        self._wake = threading.Event()

    @property
    def topology(self) -> Topology:
        return self.state.topology

    def _init_run(self) -> None:
        self.rng = random.Random(self.seed)
        self._util: dict[str, float] = {}
        self.detector = Detector(self.topology)
        self.engine = Engine()
        self._events: list[dict] = []

    def reset(self) -> None:
        """Clear faults, health, routes, series, tick and any running scenario."""
        with self.state.lock:
            failure.reset(self.state)
            self._init_run()

    def apply_event(self, ev: dict) -> None:
        OPS[ev["op"]](self.state, ev)

    # ------------------------------------------------------------------ scenarios

    def _read_scenario(self, name_or_path: str) -> dict:
        path = name_or_path if os.path.isfile(name_or_path) \
            else os.path.join(SCENARIO_DIR, f"{name_or_path}.json")
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            raise ValueError(f"cannot load scenario {name_or_path!r}: {e}") from e

    def _check_events(self, sc: dict) -> None:
        for ev in sc.get("events", []):
            if ev.get("op") not in OPS or not isinstance(ev.get("t"), int):
                raise ValueError(f"bad scenario event: {ev}")
            table = self.topology.nodes if ev["op"].endswith("node") else self.topology.links
            if ev.get("id") not in table:
                raise ValueError(f"unknown id in scenario event: {ev} (not in topology '{self.topology.name}')")

    def load_scenario(self, name_or_path: str) -> dict:
        """Read and validate a scenario by file path or by name in scenarios/."""
        sc = self._read_scenario(name_or_path)
        self._check_events(sc)
        return sc

    def scenarios(self) -> list[dict]:
        """Scenario list; `runnable` is false when it targets the current topology but its ids are gone."""
        out = []
        for sc in list_scenarios():
            problem = None
            if sc["topology"] == self.topology.name:
                for ev in sc["events"]:
                    table = self.topology.nodes if ev["op"].endswith("node") else self.topology.links
                    if ev["id"] not in table:
                        problem = f"needs {ev['id']}, which is not in this topology"
                        break
            out.append({**sc, "runnable": problem is None, "problem": problem})
        return out

    def start_scenario(self, name_or_path: str, confirm: bool = False) -> dict:
        """Reset the run and arm a scenario; step() then plays it tick by tick.

        A scenario may name the topology it needs. Switching replaces unsaved edits, so that needs `confirm`.
        """
        sc = self._read_scenario(name_or_path)
        with self.state.lock:
            wanted = sc.get("topology", "default")
            if wanted != self.topology.name:
                if self.dirty and not confirm:
                    raise TopologyDirty(wanted)
                self.load_by_name(wanted)
            self._check_events(sc)
            edited = self.dirty
            self.reset()
            self._events = list(sc.get("events", []))
            self.state.scenario.update(name=sc["name"], title=sc.get("title", sc["name"]),
                                       duration=sc["duration"], running=True, finished=False, edited=edited)
        return sc

    def stop_scenario(self) -> None:
        """Stop playing; recorded data stays."""
        with self.state.lock:
            self._events = []
            self.state.scenario["running"] = False

    def run_scenario(self, name_or_path: str) -> dict:
        """Run a scenario to completion synchronously and return its summary."""
        sc = self.start_scenario(name_or_path)
        for _ in range(sc["duration"]):
            self.step()
        return metrics.compute_summary(self.state)

    # ------------------------------------------------------------------ the tick

    def step(self) -> None:
        """One tick: events, sample, traffic, detector, engine, log."""
        st = self.state
        with st.lock:
            if st.scenario["running"]:
                for ev in [e for e in self._events if e["t"] == st.tick]:
                    self.apply_event(ev)
            st.link_metrics = monitor.sample(st, self.topology, self.rng, self.noise, self._util)
            for lid, m in st.link_metrics.items():
                st.history.setdefault(lid, deque(maxlen=60)).append(m["latency_ms"])
            traffic.step(st, self.topology)
            self.detector.update(st)
            self.engine.reconcile(st, self.topology)
            if self.log:
                flow_rows = [st.series[f][-1] for f in st.series]
                metrics.log_tick(time.time(), st.link_metrics, st.route_status(), flow_rows)
            st.tick += 1
            sc = st.scenario
            if sc["running"] and st.tick >= sc["duration"]:
                sc["running"], sc["finished"] = False, True
                st.frozen_summary = metrics.compute_summary(st)

    # ------------------------------------------------------------------ topology editing (the funnel)

    @property
    def dirty(self) -> bool:
        """Does the current topology differ from the last saved or loaded one?"""
        return self._saved_sig is None or self.topology.content_signature() != self._saved_sig

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def apply_topology(self, new_t: Topology, kind: str, summary: str, head: str | None = None,
                       record: bool = True) -> dict:
        """The single entry point for every edit: diff, clean per-link state, tell the engine, report impact."""
        st = self.state
        with st.lock:
            old = st.topology
            diff = diff_topologies(old, new_t)
            pref_before, static_before = st.baseline_path, st.static_valid()
            st.topology = new_t
            self._purge(diff)
            decision = None
            if diff.structural:
                self._refresh_baseline(diff)
                decision = self.engine.on_topology_change(st, new_t, diff, st.tick)
                if st.scenario["running"]:
                    st.scenario["edited"] = True
            if record:
                self._push(self._undo, old, summary)
                self._redo.clear()
            st.topology_version += 1
            self._after_change()
            impact = self._impact(new_t, kind, summary, head or f"{summary}.", diff, pref_before,
                                  st.baseline_path, static_before, st.static_valid(), decision)
            if kind != "node_moved":
                st.log_event("INFO", impact["message"], "topology")
            return impact

    def _purge(self, diff: TopologyDiff) -> None:
        """Remove state of deleted links/routers; initialise added links; reset smoothing of retimed links."""
        st = self.state
        gone_l, gone_n = set(diff.removed_links), set(diff.removed_nodes)
        for table in (st.link_metrics, st.history, st.impairments, st.link_health, st.ewma,
                      st.detector_progress, self._util):
            for lid in gone_l:
                table.pop(lid, None)
        st.failed_links -= gone_l
        st.failed_nodes -= gone_n
        st.dead_nodes -= gone_n
        self.detector.forget_links(gone_l)
        for f in st.fault_log:                       # the fault ended because its target is gone
            if f["restored_tick"] is None and f["target"] in gone_l | gone_n:
                f["restored_tick"] = st.tick
        for lid in diff.added_links:
            st.history[lid] = deque(maxlen=60)
            st.link_health[lid] = {"health": "healthy", "reason": None, "since": st.tick}
        for lid in diff.changed_links:
            st.ewma.pop(lid, None)

    def _refresh_baseline(self, diff: TopologyDiff) -> None:
        """Recompute the preferred path; new endpoints restart both flows."""
        st = self.state
        st.baseline_path = preferred_path(st.topology)
        if diff.endpoints_changed:
            st.static_path = st.baseline_path
            st.healing_path = st.baseline_path if has_path(st.baseline_path) else None
            st.reset_flows()
            st.log_event("INFO", "Flow endpoints changed, counters reset", "topology")

    def _after_change(self) -> None:
        self.state.topology_dirty = self.dirty
        if self.log:
            topology_store.autosave(self.topology)

    @staticmethod
    def _push(stack: list, topology: Topology, label: str) -> None:
        stack.append((topology, label))
        del stack[:-HISTORY_LIMIT]

    def _impact(self, t: Topology, kind: str, summary: str, head: str, diff: TopologyDiff, pref_before,
                pref_after, static_before: bool, static_after: bool, decision: Decision | None) -> dict:
        healing = decision.result if decision else "unchanged"
        static = "broken" if static_before and not static_after \
            else "restored" if static_after and not static_before else "unchanged"
        pack = lambda p: {"nodes": p.nodes, "cost": round(p.cost, 1)} if has_path(p) else None
        msg = head
        if healing == "rerouted":
            msg += (f" Self-healing switched to {_arrow(decision.path.nodes)} "
                    f"(cost {_fmt(round(decision.path.cost, 1))}, was {_fmt(round(decision.before_cost, 1))}).")
        elif healing == "recovered":
            msg += (f" Self-healing found a route again: {_arrow(decision.path.nodes)} "
                    f"(cost {_fmt(round(decision.path.cost, 1))}).")
        elif healing == "no_path":
            msg += (f" There is no route from {t.source} to {t.destination} now, "
                    "so self-healing is down until one appears.")
        if static == "broken":
            msg += " Static routing is broken: its manual route used a removed element. " \
                   "Use Reconfigure static route to fix it by hand."
        elif static == "restored":
            msg += " Static routing works again."
        elif healing in ("rerouted", "recovered"):
            msg += " Static routing keeps its manual route."
        if diff.structural and healing == "unchanged" and static == "unchanged":
            msg += " Routes are unchanged."
        return {"kind": kind, "tick": self.state.tick, "summary": summary,
                "preferred_before": pack(pref_before), "preferred_after": pack(pref_after),
                "healing": healing, "static": static, "warnings": warnings(t), "message": msg}

    # ---- named edits (what the API calls)

    def _build(self, op: str, body: dict) -> tuple[Topology, str, str, str, dict]:
        """Turn an edit request into (new topology, kind, summary, head sentence, extra response fields)."""
        t = self.topology
        get = body.get
        if op == "add_node":
            new, nid = add_node(t, get("x"), get("y")), f"R{t.next_node}"
            n = new.nodes[nid]
            return new, "node_added", f"Added router {nid} at ({n.x}, {n.y})", f"Added router {nid}.", {"id": nid}
        if op == "move_node":
            new = move_node(t, get("id"), get("x"), get("y"))
            return new, "node_moved", f"Moved {get('id')}", f"Moved {get('id')}.", {}
        if op == "remove_node":
            nid = get("id")
            new, gone = remove_node(t, nid)
            tail = f" and {len(gone)} link{'s' if len(gone) != 1 else ''} ({', '.join(gone)})" if gone else ""
            return new, "node_removed", f"Deleted router {nid}{tail}", f"Deleted router {nid}{tail}.", \
                {"id": nid, "removed_links": gone}
        if op == "add_link":
            a, b = get("a"), get("b")
            new, lid = add_link(t, a, b, get("latency"), get("bw", 100)), f"L{t.next_link}"
            lat = new.links[lid].latency
            return new, "link_added", f"Added link {lid} ({a}-{b}), {_fmt(lat)} ms", f"Added link {lid} ({a}-{b}).", \
                {"id": lid}
        if op == "update_link":
            lid = get("id")
            new = update_link(t, lid, get("latency"), get("bw"))
            old, cur = t.links[lid], new.links[lid]
            parts = []
            if cur.latency != old.latency:
                parts.append(f"latency to {_fmt(cur.latency)} ms (was {_fmt(old.latency)} ms)")
            if cur.bw != old.bw:
                parts.append(f"bandwidth to {_fmt(cur.bw)} Mbps (was {_fmt(old.bw)} Mbps)")
            what = " and ".join(parts) or "nothing"
            return new, "link_updated", f"Changed {lid} {what}", f"Changed {lid} {what}.", {"id": lid}
        if op == "remove_link":
            lid = get("id")
            new, l = remove_link(t, lid), t.links[lid]
            return new, "link_removed", f"Deleted link {lid} ({l.a}-{l.b})", \
                f"Deleted link {lid} ({l.a}-{l.b}), a planned change.", {"id": lid}
        if op == "set_endpoints":
            new = set_endpoints(t, get("source"), get("destination"))
            return new, "endpoints", f"Flows now run from {new.source} to {new.destination}", \
                f"Flows now run from {new.source} to {new.destination}.", {}
        raise TopologyError("op", f"unknown edit: {op}")

    def edit(self, op: str, body: dict) -> dict:
        """Apply one named edit through the funnel and return its impact."""
        with self.state.lock:
            new, kind, summary, head, extra = self._build(op, body)
            return {**self.apply_topology(new, kind, summary, head), **extra}

    def preview(self, op: str, body: dict) -> dict:
        """Dry run: the impact an edit would have, without changing anything."""
        st = self.state
        with st.lock:
            new, kind, summary, head, extra = self._build(op, body)
            diff = diff_topologies(st.topology, new)
            decision = self.engine.decide_topology_change(st, new, diff) if diff.structural else None
            return {**self._impact(new, kind, summary, head, diff, st.baseline_path, preferred_path(new),
                                   st.static_valid(), st.static_valid(new), decision), **extra, "preview": True}

    def repin_static(self) -> dict:
        """Simulate an administrator fixing the static route by hand: pin it to the preferred path."""
        st = self.state
        with st.lock:
            pref = st.baseline_path
            if not has_path(pref):
                raise TopologyError("static", "No route exists, so the static route cannot be reconfigured")
            was_valid = st.static_valid()
            st.static_path = pref
            msg = f"Static route reconfigured to {_arrow(pref.nodes)} (cost {_fmt(round(pref.cost, 1))})."
            st.log_event("INFO", msg, "topology")
            st.topology_version += 1
            return {"kind": "repin", "tick": st.tick, "summary": msg,
                    "preferred_before": None, "preferred_after": {"nodes": pref.nodes, "cost": round(pref.cost, 1)},
                    "healing": "unchanged", "static": "unchanged" if was_valid else "restored",
                    "warnings": warnings(st.topology), "message": msg}

    def undo(self) -> dict:
        """Restore the previous topology (topology only: faults and counters are not rewound)."""
        with self.state.lock:
            if not self._undo:
                raise TopologyError("history", "Nothing to undo")
            prev, label = self._undo.pop()
            cur = self.topology
            self._push(self._redo, cur, label)
            return self.apply_topology(self._restamp(prev, cur), "undo", f"Undo: {label}", record=False)

    def redo(self) -> dict:
        with self.state.lock:
            if not self._redo:
                raise TopologyError("history", "Nothing to redo")
            nxt, label = self._redo.pop()
            cur = self.topology
            self._push(self._undo, cur, label)
            return self.apply_topology(self._restamp(nxt, cur), "redo", f"Redo: {label}", record=False)

    @staticmethod
    def _restamp(target: Topology, cur: Topology) -> Topology:
        """Keep versions and id counters monotonic when going back in history."""
        return replace(target, version=cur.version + 1, layout_version=cur.layout_version + 1,
                       next_node=max(target.next_node, cur.next_node), next_link=max(target.next_link, cur.next_link))

    # ---- whole-topology operations

    def replace_topology(self, new_t: Topology, kind: str, summary: str, saved: bool = True) -> dict:
        """Swap in a different topology (load, import, reset). The run restarts; the old one stays undoable."""
        st = self.state
        with st.lock:
            old = st.topology
            self._push(self._undo, old, summary)
            self._redo.clear()
            st.topology = replace(new_t, version=max(new_t.version, old.version) + 1)
            st.reset_run()
            self._init_run()
            st.topology_version += 1
            self._saved_sig = st.topology.content_signature() if saved else None
            self._after_change()
            st.log_event("INFO", f"{summary}.", "topology")
            pref = st.baseline_path
            return {"kind": kind, "tick": st.tick, "summary": summary, "preferred_before": None,
                    "preferred_after": {"nodes": pref.nodes, "cost": round(pref.cost, 1)} if has_path(pref) else None,
                    "healing": "unchanged", "static": "unchanged", "warnings": warnings(st.topology),
                    "message": f"{summary}."}

    def load_by_name(self, name: str) -> dict:
        """Load `default`, a preset or a saved topology."""
        return self.replace_topology(topology_store.load(name), "load", f"Loaded topology '{name}'")

    def reset_topology(self) -> dict:
        return self.replace_topology(topology_store.load("default"), "reset", "Reset to the default topology")

    def import_topology(self, text: str) -> dict:
        t = topology_store.import_json(text)
        return self.replace_topology(t, "import", f"Imported topology '{t.name}'", saved=False)

    def save_as(self, name: str) -> None:
        """Save the current topology under a user name; it becomes the clean reference."""
        with self.state.lock:
            topology_store.save(name, self.topology)
            self.state.topology = replace(self.topology, name=name)
            self._saved_sig = self.topology.content_signature()
            self.state.topology_version += 1
            self._after_change()

    def topology_payload(self) -> dict:
        """What GET /api/topology returns: the model plus editor metadata."""
        with self.state.lock:
            t = self.topology
            return {**t.to_dict(), "dirty": self.dirty, "warnings": warnings(t),
                    "limits": {k: list(v) if isinstance(v, tuple) else v for k, v in LIMITS.items()},
                    "can_undo": self.can_undo, "can_redo": self.can_redo}

    # ------------------------------------------------------------------ run control

    def pause(self) -> None:
        with self.state.lock:
            self.state.paused = True

    def resume(self) -> None:
        with self.state.lock:
            self.state.paused = False
        self._wake.set()

    def step_once(self) -> None:
        """Advance exactly one tick; only allowed while paused."""
        with self.state.lock:
            if not self.state.paused:
                raise ValueError("step is only allowed while paused")
            self.step()

    def set_speed(self, tick_seconds: float) -> None:
        if not MIN_TICK_SECONDS <= tick_seconds <= MAX_TICK_SECONDS:
            raise ValueError(f"tick_seconds must be between {MIN_TICK_SECONDS} and {MAX_TICK_SECONDS}")
        with self.state.lock:
            self.state.tick_seconds = float(tick_seconds)
        self._wake.set()

    def summary(self) -> dict:
        """Frozen summary of a finished scenario, otherwise the live one."""
        with self.state.lock:
            return self.state.frozen_summary or metrics.compute_summary(self.state)

    def start(self) -> None:
        """Run step() every tick_seconds on a daemon thread, honouring pause and speed."""
        def loop() -> None:
            while True:
                if not self.state.paused:
                    try:
                        self.step()
                    except Exception:
                        traceback.print_exc()
                self._wake.wait(self.state.tick_seconds)
                self._wake.clear()
        self._thread = threading.Thread(target=loop, daemon=True, name="simulation")
        self._thread.start()
