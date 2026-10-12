"""One step() that runs the whole pipeline in a fixed order, plus the scenario player."""
import glob
import json
import os
import random
import threading
import time
import traceback

import failure
import metrics
import monitor
import traffic
from config import TICK_SECONDS

MIN_TICK_SECONDS, MAX_TICK_SECONDS = 0.25, 3.0
from detector import Detector
from engine import Engine
from state import State
from topology import Topology

SCENARIO_DIR = "scenarios"

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
                    "events": d.get("events", [])})
    return out


class Simulation:
    """Owns state, monitor RNG, detector, engine and the scenario player."""

    def __init__(self, topology: Topology, noise: bool = True, seed: int | None = None,
                 log: bool = True):
        self.topology, self.noise, self.seed, self.log = topology, noise, seed, log
        self.state = State(topology)
        self._init_run()
        self._thread: threading.Thread | None = None
        self._wake = threading.Event()

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

    def load_scenario(self, name_or_path: str) -> dict:
        """Read and validate a scenario by file path or by name in scenarios/."""
        path = name_or_path if os.path.isfile(name_or_path) \
            else os.path.join(SCENARIO_DIR, f"{name_or_path}.json")
        try:
            with open(path) as f:
                sc = json.load(f)
        except (OSError, ValueError) as e:
            raise ValueError(f"cannot load scenario {name_or_path!r}: {e}") from e
        for ev in sc.get("events", []):
            if ev.get("op") not in OPS or not isinstance(ev.get("t"), int):
                raise ValueError(f"bad scenario event: {ev}")
            table = self.topology.nodes if ev["op"].endswith("node") else self.topology.links
            if ev.get("id") not in table:
                raise ValueError(f"unknown id in scenario event: {ev}")
        return sc

    def start_scenario(self, name_or_path: str) -> dict:
        """Reset the run and arm a scenario; step() then plays it tick by tick."""
        sc = self.load_scenario(name_or_path)
        with self.state.lock:
            self.reset()
            self._events = list(sc.get("events", []))
            self.state.scenario.update(name=sc["name"], title=sc.get("title", sc["name"]),
                                       duration=sc["duration"], running=True, finished=False)
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

    def step(self) -> None:
        """One tick: events, sample, traffic, detector, engine, log."""
        st = self.state
        with st.lock:
            if st.scenario["running"]:
                for ev in [e for e in self._events if e["t"] == st.tick]:
                    self.apply_event(ev)
            st.link_metrics = monitor.sample(st, self.topology, self.rng, self.noise, self._util)
            for lid, m in st.link_metrics.items():
                st.history[lid].append(m["latency_ms"])
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
