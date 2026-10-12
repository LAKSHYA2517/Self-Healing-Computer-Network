# Self-Healing Computer Network — Review 2

A simulated 10-router network that **detects failures from metrics alone, reroutes automatically,
and fails back without flapping**. A second flow that uses plain static routing runs on the same
network, so the dashboard shows self-healing versus static routing live.

## Setup and run

```
python3.11 -m venv .venv && source .venv/bin/activate     # Python 3.10+
pip install -r requirements.txt
python app.py                                             # http://127.0.0.1:3000
pytest                                                    # backend tests
python app.py --no-noise                                  # exact metrics: same numbers as the CLI below
python scenario_runner.py scenarios/link_failure.json     # headless scenario + summary table
```

Use `127.0.0.1` rather than `localhost` (on macOS another service can answer on IPv6).
The React dashboard is pre-built in `frontend/dist` and served by Flask, so the demo machine needs only
Python. The previous plain-JS dashboard is still available at `/legacy/`.

## Architecture

```
                    scenario events / manual buttons (failure.py = ground truth)
                                       |
 Simulation.step()  --------------------------------------------------------------
   1 apply scheduled events      state.failed_links / failed_nodes / impairments
   2 monitor.sample()      --->  state.link_metrics        (the ONLY thing below reads)
   3 traffic.step()        --->  static flow on baseline path, healing flow on healing path
   4 detector.update()     --->  state.link_health, state.dead_nodes (inferred), state.ewma
   5 engine.reconcile()    --->  state.healing_path (reroute / failback / recovery)
   6 metrics.log_tick()    --->  logs/metrics.csv, logs/flows.csv;  state.tick += 1
                                       |
        Flask API (app.py)  <---  state.snapshot()  --->  dashboard (static/)
```

The detector and engine never read the injected failures: `tests/test_detector.py` checks their
source for `failed_links`, `failed_nodes` and `impairments`. The ground-truth `fault_log` is used
only by `metrics.py` to compute detection and recovery time.

| Module | Role |
|---|---|
| `config.py` | All tunable constants |
| `topology.py`, `topology.json` | Topology data, validation, NetworkX conversion |
| `routing.py` | `compute_path`, `live_cost`, `compute_healing_path`, `path_is_intact` |
| `state.py` | Shared thread-safe state and JSON snapshot |
| `monitor.py` | `sample()`: simulated per-link metrics plus impairments |
| `failure.py` | fail/restore link or node, degrade, congest, clear, reset |
| `detector.py` | healthy / degraded / down per link with hysteresis; node inference |
| `engine.py` | Reroute, failback (hold-down), recovery from "no path" |
| `traffic.py` | Static and healing flows, per-tick delivery/delay/throughput |
| `simulation.py` | `step()`, scenario player, background thread |
| `metrics.py` | CSV logging, run summary |
| `scenario_runner.py`, `scenarios/` | Repeatable headless scenarios |

## How detection and healing work

- **Detection:** a sample is *down* (no response), *degraded* (loss > 5 %, latency > 2.5× base, or
  utilization > 85 %) or *good*. A link is declared down after `K_DOWN` consecutive down samples,
  degraded after `K_DEGRADED`, and healthy again only after `K_RECOVER` consecutive good samples.
- **Node inference:** a router is dead when all of its links are down. No node-failure message exists.
- **Reroute:** if the active path has a down/degraded link or a dead node, Dijkstra runs on the
  graph without down links and dead nodes, using the live cost below.
- **Failback:** only when every link of the preferred path is healthy again *and* at least
  `HOLD_DOWN_TICKS` have passed since the last route change. The engine reacts to health changes,
  never to metric jitter, so it cannot flap.
- **Live cost:** `base + max(0, ewma_lat - 1.3·base) + 2·max(0, ewma_loss - 2) + 0.5·max(0, ewma_util - 60) + 50 if degraded`.
  Under normal jitter this equals `base`, so normal path selection is stable.

## Config constants (`config.py`)

| Constant | Value | Meaning |
|---|---|---|
| `TICK_SECONDS` | 1.0 | Real-time length of a tick |
| `PACKETS_PER_TICK` | 100 | Packets each flow sends per tick |
| `K_DOWN` | 2 | Consecutive down samples to declare a link down |
| `K_DEGRADED` | 3 | Consecutive degraded samples to declare degraded |
| `K_RECOVER` | 5 | Consecutive good samples to declare healthy again |
| `LOSS_DEGRADED_PCT` | 5.0 | Loss above this is degraded |
| `LATENCY_DEGRADED_FACTOR` | 2.5 | Latency above factor × base is degraded |
| `UTIL_CONGESTED_PCT` | 85.0 | Utilization above this is degraded (congestion) |
| `HOLD_DOWN_TICKS` | 10 | Minimum ticks between route changes (failback only) |
| `DEGRADED_PENALTY` | 50.0 | Added to the live cost of a degraded link |
| `AVAILABLE_DELIVERY` | 0.90 | Delivery ratio for a tick to count as available |
| `EWMA_ALPHA` | 0.3 | Smoothing of latency/loss/utilization |
| `SERIES_LEN` | 120 | Ticks of chart history kept |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/topology` | – | nodes, links, source, destination |
| GET | `/api/state` | – | tick, link_health, dead_nodes, static_path, healing_path, route_changes, kpis, series, events, scenario, link_metrics, impairments, … |
| POST | `/api/fail` | `{"type":"link"\|"node","id":"L8"}` | updated snapshot |
| POST | `/api/restore` | same (also clears a link's impairments) | updated snapshot |
| POST | `/api/degrade` | `{"id":"L8","loss_pct":25}` (`latency_mult` optional) | updated snapshot |
| POST | `/api/congest` | `{"id":"L8","util_pct":95}` | updated snapshot |
| POST | `/api/clear` | `{"id":"L8"}` | updated snapshot |
| POST | `/api/reset` | – | updated snapshot |
| GET | `/api/scenarios` | – | list of `{name, title, duration}` |
| POST | `/api/scenario/start` | `{"name":"link_failure"}` | resets the sim and plays the scenario in real time |
| POST | `/api/scenario/stop` | – | stops playing, keeps data |
| GET | `/api/summary` | – | per-flow summary (frozen when a scenario has finished) |
| GET | `/api/export` | – | per-tick rows as CSV download |

Bad input returns 400 with `{"error": "..."}`.

## Scenarios

```json
{"name": "link_failure", "title": "Single link failure on the active path", "duration": 60,
 "events": [{"t": 10, "op": "fail_link", "id": "L8"}, {"t": 40, "op": "restore_link", "id": "L8"}]}
```

Ops: `fail_link`, `restore_link`, `fail_node`, `restore_node`, `degrade_link` (`loss_pct`,
optional `latency_mult`), `congest_link` (`util_pct`), `clear_link`. An event at tick `t` takes
effect on that tick's samples. Add a file to `scenarios/` and it appears in the dashboard.

Run headless (noise off by default, no sleeping):

```
python scenario_runner.py scenarios/link_failure.json [--noise] [--seed N]
```

It prints the static vs healing table and writes `results/<name>_summary.csv` and
`results/<name>_ticks.csv`.

Reference results (60 ticks, noise off):

| Scenario | Detected | Reroute | Recovery | Lost static / healing | Available ticks | Route changes |
|---|---|---|---|---|---|---|
| link_failure | L8 down @11 | @11 via R4, cost 34 | 2 ticks | 3000 / 200 | 30 / 58 | reroute @11, failback @44 |
| link_degradation | L8 degraded @12 | @12 | 3 ticks | 750 / 75 | 30 / 57 | reroute @12, failback @44 |
| node_failure | L4,L5,L8,L9 down @11, R5 dead | @11 | 2 ticks | 3000 / 200 | 30 / 58 | reroute @11, failback @44 |
| off_path_failure | L14 down @11 | none | n/a | 0 / 0 | 60 / 60 | none |

The live dashboard runs with metric jitter on, so its totals differ from the noise-off CLI numbers
by the background loss (about 0.3 % per link); detection, reroute, failback ticks and outage ticks match.

## Demo script

1. Start the dashboard: both flows on the purple/blue path, ~100 % delivery, flat charts.
2. Run `link_failure`. *"At tick 10 L8 fails. The static flow has no way to recover, so delivery
   drops to zero. Our detector confirms the failure after 2 consecutive bad samples, the path engine
   removes L8, runs Dijkstra on the remaining graph and installs R1-R2-R4-R7-R9-R10 at cost 34. Only
   2 ticks of traffic were lost."*
3. At tick 40 the link is restored. *"The engine does not switch back at once. It waits for 5 clean
   samples and a hold-down timer so a flapping link cannot cause route oscillation. It fails back at
   tick 44."*
4. Show the summary: lost packets 3000 vs 200, availability 50 % vs 96.7 %.
5. Run `link_degradation`: *"The link is still up but 25 % lossy. A plain up/down check would miss
   it. Our detector flags it from loss and moves traffic away."*
6. Run `node_failure`: *"The engine never sees a node-failure message. It infers router R5 is dead
   because all 4 of its links stopped responding."*
7. Run `off_path_failure`: *"A fault on a link we are not using is detected but causes no reroute."*
8. Manual: select L8, set Util 95 and press Congest; the health table shows `degraded (congestion)`
   and the healing flow reroutes.


## Frontend (React dashboard)

Vite + React 18 + TypeScript (strict), Tailwind, Zustand, Recharts, framer-motion. The network is custom SVG
(two lanes per link, moving packets). Everything the screen shows is derived from `/api/state`.

```
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api to the Flask backend on 127.0.0.1:3000
npm run build      # type-checks, then writes frontend/dist (committed; Flask serves it at /)
npm run test       # vitest: phase, narration, layout, flow status, timeline, CSV, FlowCard
npm run shots      # Playwright screenshots + overflow check at 1366x768 and 1920x1080
```

Colours are fixed everywhere: **self-healing = blue solid, static = orange dashed**; link health is
gray (healthy), amber dotted (degraded), red dashed with a cross and the word DOWN.

### Folder map

| Path | Role |
|---|---|
| `src/api/` | `types.ts` (mirrors the real API), `client.ts` (live backend and offline replay backend) |
| `src/store/useSimStore.ts` | Polling, 300-snapshot ring buffer, scrub cursor, guided demo, recordings |
| `src/domain/` | Pure functions: `phase.ts`, `narration.ts`, `flowStatus.ts`, `milestones.ts`, `layout.ts`, `glossary.ts` |
| `src/components/NetworkCanvas/` | Links, nodes, lanes, packets |
| `src/components/` | Header, narration banner, flow cards, pipeline, timeline, guided demo, help |
| `src/components/panels/` | Charts, events, link health, manual controls, results |
| `src/test/` | Unit tests and real fixtures from `scenario_runner.py --dump-snapshots` |

### Recording and replay (demo insurance)

```
python scenario_runner.py scenarios/link_failure.json --dump-snapshots results/link_failure_snapshots.json
```

Open any static copy of `frontend/dist` (or `npm run preview`) with
`/?replay=/recordings/link_failure_snapshots.json` and the whole UI runs from the recording with no
backend; a "Replay mode" badge is always visible. A sample recording ships in `frontend/public/recordings/`.
In the **Manual controls** tab, *Save recording* downloads the last 300 ticks and *Load recording*
plays a saved file. In replay mode Run, Pause, Step, Speed, the scrubber and the guided demo all work;
fault injection is disabled.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Next milestone (guided demo) |
| `N` | Step one tick (pauses first) |
| `R` | Run the selected scenario |
| `P` | Pause / resume |
| `G` | Start / end the guided demo |
| `?` | Help and glossary |
| `Esc` | Close help / details |

### API added for the frontend

`POST /api/pause`, `POST /api/resume`, `POST /api/step` (only while paused), `POST /api/speed`
(`{"tick_seconds": 0.25..3}`). `/api/state` also returns `paused`, `tick_seconds`, `config`,
`detector_progress` and `fault_log` (`{tick, op, target, restored_tick, description}`), every event has
a `kind`, and `/api/scenarios` includes each scenario's planned `events`.

## 3-minute explanation script

1. (20 s) "Two identical flows send traffic from R1 to R10. Orange uses static routing, blue is
   self-healing. Both start on the same path."
2. (20 s) Press **Guided demo**, then Space. "At t=10 link L8 fails. Look at the bottom of the right
   panel: Reality says it is down, but the system knows nothing yet."
3. (40 s) Space. "After 2 failed checks it confirms the failure. The path engine removes L8, runs
   Dijkstra on the rest of the graph, and the route updater installs R1-R2-R4-R7-R9-R10. Orange packets
   keep dying at the broken link; blue packets go around it."
4. (30 s) Space. "When L8 is restored the system does not trust it immediately. It needs 5 clean checks
   and a hold-down timer so a flapping link cannot make the route oscillate."
5. (20 s) Space. "Failback to the shortest path."
6. (30 s) Space once more: "Static lost 3000 packets and was available 50% of the time. Self-healing
   lost 200 and was available 96.7%." (Start the server with `--no-noise` for these exact numbers.)
7. (20 s) Mention the other scenarios: degradation (link up but lossy), node failure (inferred from all
   its links failing), off-path fault (no reroute needed).
