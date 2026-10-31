"""Summarise Lanework's resource log (FE-115).

Reads the hourly JSON-lines files the desktop app writes to
<appHome>/metrics (default ~/.lanew/metrics) while Settings > About >
Resource log is on, and prints, for the last N hours:

- CPU (% of one core, as `ps` counts) and memory (MB) per process type:
  average, p95 and max;
- average CPU by window state and by whether an agent was working, the two
  things that explained FE-111 and FE-113;
- the top spikes, each with what the app was doing then.

Usage: python3 -I main.py [metrics_dir] [--hours 24] [--top 8]
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

PROCS = ["main", "renderer", "gpu", "utility", "other"]


def load(directory, hours):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    samples = []
    try:
        names = sorted(os.listdir(directory))
    except FileNotFoundError:
        sys.exit(f"No resource log at {directory}. Switch it on in Settings > About.")
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(directory, name), encoding="utf-8") as handle:
            for line in handle:
                try:
                    sample = json.loads(line)
                    at = datetime.fromisoformat(sample["t"].replace("Z", "+00:00"))
                except (ValueError, KeyError):
                    continue
                if at >= since:
                    sample["_at"] = at
                    samples.append(sample)
    return samples


def pct(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def avg(values):
    return sum(values) / len(values) if values else 0.0


def total(sample):
    return sum(sample["cpu"].get(p, 0) for p in PROCS)


def context(sample):
    parts = [
        f"window={sample.get('window')}",
        f"route={sample.get('route')}",
        f"working={sample.get('working')}",
        f"bg={sample.get('background')}",
        f"terminals={sample.get('terminals')}",
    ]
    if sample.get("pulling"):
        parts.append("pulling")
    return " ".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "directory",
        nargs="?",
        default=os.path.join(os.path.expanduser("~"), ".lanew", "metrics"),
    )
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--top", type=int, default=8)
    args = parser.parse_args()

    samples = load(args.directory, args.hours)
    if not samples:
        sys.exit(f"No samples in the last {args.hours:g} h in {args.directory}.")
    first, last = samples[0]["_at"], samples[-1]["_at"]
    print(
        f"{len(samples)} samples, {first:%Y-%m-%d %H:%M} to {last:%Y-%m-%d %H:%M} UTC, "
        f"version {samples[-1].get('v')}, {samples[-1].get('cores')} cores"
    )

    print("\nCPU % of one core            avg     p95     max")
    for proc in PROCS + ["total"]:
        values = [total(s) if proc == "total" else s["cpu"].get(proc, 0) for s in samples]
        if proc != "total" and max(values) == 0:
            continue
        print(f"  {proc:<24} {avg(values):6.1f}  {pct(values, 0.95):6.1f}  {max(values):6.1f}")

    print("\nMemory MB                    avg     max")
    for proc in PROCS:
        values = [s["mem"].get(proc, 0) for s in samples]
        if max(values) == 0:
            continue
        print(f"  {proc:<24} {avg(values):6.0f}  {max(values):6.0f}")

    def by(label, key):
        groups = {}
        for sample in samples:
            groups.setdefault(key(sample), []).append(sample)
        print(f"\nBy {label:<14} samples  main  renderer   gpu")
        for name, group in sorted(groups.items(), key=lambda item: str(item[0])):
            print(
                f"  {str(name):<20} {len(group):5d} "
                f"{avg([s['cpu']['main'] for s in group]):5.1f} "
                f"{avg([s['cpu']['renderer'] for s in group]):9.1f} "
                f"{avg([s['cpu']['gpu'] for s in group]):5.1f}"
            )

    by("window", lambda s: s.get("window"))
    by("agent working", lambda s: "yes" if s.get("working", 0) > 0 else "no")

    print(f"\nTop {args.top} by total CPU")
    for sample in sorted(samples, key=total, reverse=True)[: args.top]:
        cpu = sample["cpu"]
        print(
            f"  {sample['_at']:%m-%d %H:%M:%S}  total {total(sample):5.1f}  "
            f"main {cpu['main']:5.1f}  renderer {cpu['renderer']:5.1f}  gpu {cpu['gpu']:5.1f}  "
            f"{context(sample)}"
        )


if __name__ == "__main__":
    main()
