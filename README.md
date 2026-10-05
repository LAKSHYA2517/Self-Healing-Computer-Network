# Self-Healing Computer Network — Review 1

Simulated 10-router network with a drawn topology, a baseline Dijkstra route (R1 → R10), live
simulated link metrics, and manual failure injection that visibly breaks the baseline route.
Automatic detection and rerouting come in Review 2.

## Setup and run

```
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py            # http://127.0.0.1:5000
pytest                   # run tests
```

Use `127.0.0.1` rather than `localhost`: on macOS, AirPlay Receiver can claim port 5000 on IPv6.
vis-network is vendored in `static/vendor/`, so the demo works offline.

## Structure

| File | Role |
|---|---|
| `topology.json`, `topology.py` | Topology data, loading, validation, NetworkX conversion |
| `routing.py` | `compute_path` (Dijkstra, static or live cost), `path_is_intact` |
| `state.py` | Shared thread-safe state, `route_status`, `snapshot` |
| `failure.py` | Fail/restore link or node, reset, event logging |
| `monitor.py` | 1 s background thread generating simulated metrics |
| `metrics.py` | Appends metrics to `logs/metrics.csv` |
| `app.py` | Flask server and JSON API |
| `static/` | Dashboard (HTML/CSS/JS) |
| `tests/` | pytest suite |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/topology` | – | nodes, links, source, destination |
| GET | `/api/state` | – | failed_links, failed_nodes, baseline_path, route_status, link_metrics, history, events |
| POST | `/api/fail` | `{"type":"link"\|"node","id":"L8"}` | updated snapshot |
| POST | `/api/restore` | same | updated snapshot |
| POST | `/api/reset` | – | updated snapshot |

Bad input returns 400 with `{"error": "..."}`.

## Demo walkthrough

1. Open the dashboard: topology, green baseline path (cost 33), live metrics.
2. Fail **L14**: link turns red, route still OK (a failure off the active path does not matter).
3. Fail **L8**: baseline turns red, banner shows BROKEN, WARN event logged.
   *"In Review 2 the detector flags this from metrics and the path engine reroutes automatically."*
4. Restore **L8**: route OK again.
5. Fail node **R5**: node and its links go red, route breaks. Click **Reset all**.

The optional "Preview alternate path" button was not built.
