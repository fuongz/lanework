#!/usr/bin/env python3
"""Write a fake usage history for trying the usage forecast island (FE-181).

The dev app reads the file named by LANEWORK_TEST_USAGE_HISTORY on every call
(only with LANEWORK_TEST_USER_DATA set, so never in a packaged app). Every
sample is stamped relative to the moment this script runs, because the
forecast depends on "now".

    python3 -I main.py list
    python3 -I main.py apply hot-5h [--out DIR]
    python3 -I main.py clear [--out DIR]
"""

import argparse
import json
import sys
import time
from pathlib import Path

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
DEFAULT_OUT = ".agents/scratch/usage-forecast"


def ramp(now, resets_at, from_min, from_pct, to_pct, step=5, until_min=0):
    """Samples every `step` minutes from `from_min` ago to `until_min` ago,
    rising linearly from `from_pct` to `to_pct`."""
    out = []
    span = from_min - until_min
    minute = from_min
    while minute >= until_min:
        pct = from_pct + (to_pct - from_pct) * (from_min - minute) / span
        out.append(
            {
                "at": now - minute * MIN,
                "usedPercent": round(pct, 1),
                "resetsAt": resets_at,
            }
        )
        minute -= step
    return out


def hot_5h(now):
    resets = now + 4 * HOUR
    return {"claude:five-hour": ramp(now, resets, 60, 0, 50)}


def calm_5h(now):
    resets = now + 4 * HOUR
    return {"claude:five-hour": ramp(now, resets, 60, 0, 10)}


def burst_5h(now):
    resets = now + 150 * MIN
    slow = ramp(now, resets, 150, 0, 5, step=10, until_min=70)
    fast = ramp(now, resets, 60, 5, 40)
    return {"claude:five-hour": slow + fast}


def marginal_5h(now):
    resets = now + 3 * HOUR
    early = ramp(now, resets, 120, 0, 27, until_min=65)
    recent = ramp(now, resets, 60, 27.8, 50)
    return {"claude:five-hour": early + recent}


def exhausted_5h(now):
    resets = now + 90 * MIN
    return {"claude:five-hour": ramp(now, resets, 60, 70, 100)}


def few_samples(now):
    resets = now + 4 * HOUR
    return {
        "claude:five-hour": [
            {"at": now - 10 * MIN, "usedPercent": 38, "resetsAt": resets},
            {"at": now, "usedPercent": 40, "resetsAt": resets},
        ]
    }


def expired(now):
    resets = now - 10 * MIN
    return {"claude:five-hour": ramp(now, resets, 60, 0, 50)}


def hot_weekly(now):
    resets = now + 5 * DAY
    first = ramp(now, resets, 48 * 60, 0, 20, step=30, until_min=24 * 60 + 30)
    last = ramp(now, resets, 24 * 60, 20, 62, step=30)
    return {"codex:weekly": first + last}


def both(now):
    return {**hot_5h(now), **hot_weekly(now)}


# name -> (builder, what to expect with the default settings)
SCENARIOS = {
    "hot-5h": (
        hot_5h,
        "Claude 5-hour pill: runs out in about 1 h, about 3 h before the reset.",
    ),
    "calm-5h": (calm_5h, "Nothing: only 10% used (quiet below 25%)."),
    "burst-5h": (
        burst_5h,
        "Nothing: a short burst; the window's average pace does not run out.",
    ),
    "marginal-5h": (
        marginal_5h,
        "Claude 5-hour pill, about 45 min before the reset: shows at margin "
        "15 or 30 min, hides at 1 h or 2 h.",
    ),
    "exhausted-5h": (
        exhausted_5h,
        "Claude 5-hour pill reading 'has run out' (100% used, 90 min to the "
        "reset): hides only at margin 2 h.",
    ),
    "few-samples": (few_samples, "Nothing: fewer than 3 samples."),
    "expired": (expired, "Nothing: the window already reset."),
    "hot-weekly": (
        hot_weekly,
        "Codex weekly pill: runs out in about 1.2 days, days before the reset.",
    ),
    "both": (
        both,
        "Claude 5-hour and Codex weekly at once; the island shows the newest "
        "one at a time (the other waits behind it).",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    for name in ("apply", "clear"):
        one = sub.add_parser(name)
        if name == "apply":
            one.add_argument("scenario", choices=sorted(SCENARIOS))
        one.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    if args.cmd == "list":
        for name, (_, expect) in SCENARIOS.items():
            print(f"{name:13} {expect}")
        return 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    target = out / "current.json"
    now = int(time.time() * 1000)
    history = {} if args.cmd == "clear" else SCENARIOS[args.scenario][0](now)
    tmp = out / "current.json.tmp"
    tmp.write_text(json.dumps(history, indent=1))
    tmp.replace(target)
    label = "cleared" if args.cmd == "clear" else f"applied {args.scenario}"
    print(f"{label}: {target.resolve()}")
    if args.cmd == "apply":
        print("Expect:", SCENARIOS[args.scenario][1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
