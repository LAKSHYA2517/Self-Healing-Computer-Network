"""Headless scenario runner: python scenario_runner.py scenarios/link_failure.json [--noise] [--seed N]"""
import argparse
import os

import metrics
from simulation import Simulation
from topology import load_topology

ROWS = [("Packets sent", "sent"), ("Packets lost", "lost"), ("Loss %", "loss_pct"),
        ("Outage ticks", "outage_ticks"), ("Availability %", "availability_pct"),
        ("Route changes", "route_changes"), ("Avg delay ms", "avg_delay_ms"),
        ("Avg throughput Mbps", "avg_throughput_mbps")]


def format_summary(summary: dict) -> str:
    """Static vs healing table plus per-fault detection/recovery."""
    lines = [f"{'metric':<22}{'static':>12}{'healing':>12}"]
    for label, key in ROWS:
        a, b = summary["static"][key], summary["healing"][key]
        lines.append(f"{label:<22}{'-' if a is None else a:>12}{'-' if b is None else b:>12}")
    for f in summary["healing"]["faults"]:
        lines.append(f"fault t={f['fault_tick']}: {f['fault']} | detected after {f['detection_ticks']} "
                     f"ticks | recovery {f['recovery_ticks']} ticks")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scenario", help="path to a scenario JSON file")
    ap.add_argument("--noise", action="store_true", help="enable metric jitter (default: off)")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    sim = Simulation(load_topology(), noise=args.noise, seed=args.seed, log=False)
    summary = sim.run_scenario(args.scenario)
    name = sim.state.scenario["name"]
    print(f"Scenario: {sim.state.scenario['title']} ({summary['ticks']} ticks, "
          f"noise {'on' if args.noise else 'off'})")
    print(format_summary(summary))
    metrics.write_summary_csv(summary, os.path.join("results", f"{name}_summary.csv"))
    with open(os.path.join("results", f"{name}_ticks.csv"), "w", newline="") as f:
        f.write(metrics.rows_to_csv(sim.state.rows))
    print(f"wrote results/{name}_summary.csv and results/{name}_ticks.csv")


if __name__ == "__main__":
    main()
