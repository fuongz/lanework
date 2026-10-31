---
name: lanework-metrics
description: Summarise the desktop app's 24-hour resource log (CPU and memory per process, with what the app was doing) to find what makes Lanework hot.
runtime: python3
entrypoint: python3 -I main.py [metrics_dir] [--hours 24] [--top 8]
---

# lanework-metrics

The desktop app writes one JSON line every 30 s to
`<appHome>/metrics/<YYYY-MM-DDTHH>.jsonl` (UTC hour, newest 24 kept) while
**Settings › About › Resource log** is on. It is off by default (FE-115).

```bash
python3 -I .claude/tools/lanework-metrics/main.py            # ~/.lanew/metrics
python3 -I .claude/tools/lanework-metrics/main.py --hours 2  # the last 2 hours
```

Prints average, p95 and max CPU (% of one core, as `ps` counts) and memory
per process type, CPU split by window state and by whether an agent was
working, and the top spikes with their context (window, route template,
working agents, background tasks, terminals, Pull).

A line holds numbers and counts only: no project name, path, or title. The
route keeps the app's own words and replaces every name or id with `$`.
