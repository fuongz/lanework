---
name: usage-forecast-seed
description: Write a fake Claude/Codex usage history (stamped relative to now) so the usage forecast island (FE-181) can be tried in the dev app without real quota use.
runtime: python3
entrypoint: python3 -I main.py <list|apply SCENARIO|clear> [--out DIR]
---

# usage-forecast-seed

The forecast island warns when a 5-hour or weekly quota would run out before
it resets. It reads the recorded readings through `usageHistory()`; in a dev
build, `LANEWORK_TEST_USAGE_HISTORY=<file>` (with `LANEWORK_TEST_USER_DATA`
set, which the `run-desktop` driver does) answers that call from a JSON file
read afresh each time. A packaged app ignores it.

```bash
python3 -I .claude/tools/usage-forecast-seed/main.py list
python3 -I .claude/tools/usage-forecast-seed/main.py apply hot-5h
python3 -I .claude/tools/usage-forecast-seed/main.py clear
```

`apply` writes `.agents/scratch/usage-forecast/current.json` (git-ignored).
Run it again with another scenario while the app is open: the island reloads
every 60 s and whenever the window gains focus.

## Try it in the real app (isolated profile)

```bash
bun run build                      # once; the driver runs dist/
python3 -I .claude/tools/usage-forecast-seed/main.py apply hot-5h
LANEWORK_TEST_USAGE_HISTORY="$PWD/.agents/scratch/usage-forecast/current.json" \
  node .claude/skills/run-desktop/driver.mjs <<'EOF'
goto /w/lanework
wait 1800000
quit
EOF
```

The window stays open for 30 minutes on a throwaway profile (the real
`~/.lanew` and logins are untouched). Click into it, then run `apply` with
another scenario from a second terminal.

## Scenarios (default settings: margin 30 min)

| Scenario | Expect |
| --- | --- |
| `hot-5h` | Claude 5-hour pill: runs out in about 1 h, about 3 h before the reset |
| `calm-5h` | Nothing: 10% used, quiet below 25% |
| `burst-5h` | Nothing: a short burst, the window's average pace does not run out |
| `marginal-5h` | Claude 5-hour pill about 45 min before the reset: shown at margin 15 or 30 min, hidden at 1 h or 2 h |
| `exhausted-5h` | Claude 5-hour pill reading "has run out"; hidden only at margin 2 h |
| `few-samples` | Nothing: fewer than 3 samples |
| `expired` | Nothing: the window already reset |
| `hot-weekly` | Codex weekly pill: runs out in about 1.2 days, about 4 days before the reset |
| `both` | Claude 5-hour and Codex weekly: one shows at a time, the newest registration |

## Notes

- The island is mounted in the app shell, so it does not show on `/settings/*`
  pages; change the margin there, then go back to a project page.
- Dismiss lasts until that window's `resetsAt` moves by more than 5 minutes,
  and is kept in localStorage (`lanework.usage-forecast.quiet`, with Snooze).
  Re-applying the same scenario keeps it dismissed; applying a different one
  (a different `resetsAt`) brings it back.
- Hover over the pill opens the panel; Alt+T focuses the island and opens it.
