---
name: run-desktop
description: Launch the built Lanework desktop app (Electron, apps/desktop) and drive it like a user — navigate, click, read the screen, screenshot — in an isolated local-mode profile. Use to check a change in the real app (not the test suite), e.g. Pull requests, Changes, History, Settings.
---

# Run the desktop app

A Playwright `_electron` driver for `apps/desktop/dist`. Not a test: it runs
no spec, so the repo's "no tests unless asked" rule does not block it. It does
drive the real app, so keep it read-only on GitHub (no merge, review or
comment) unless the user asked for that.

## Before

```bash
bun run build          # the driver runs dist/, not the sources
```

## Launch

From the repo root, commands on stdin, one per line:

```bash
node .claude/skills/run-desktop/driver.mjs [--folder <path>] [--gh real|missing|loggedout|offline] [--shots <dir>] [--no-setup] <<'EOF'
goto /w/lanework/pulls?status=merged
wait 5000
shot pulls
click Harness update island
tab Summary
text Activity
quit
EOF
```

What setup does (skip with `--no-setup`):

- Temp `LANEWORK_HOME` and userData. The real `~/.lanew` and login are never
  touched.
- Temp agent config, always (also with `--no-setup`): `LANEWORK_TEST_AGENT_HOME`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `LANEWORK_HOOK_SECRET_FILE` all point
  under the temp profile, as `apps/desktop/tests/auth-fixtures.ts`
  `agentConfigEnv` does. The app's `lanework` MCP entry and Stop hook land
  there, so the real `~/.claude.json`, `~/.claude/settings.json` and Codex
  config are not rewritten. The flip side: the app sees no real Claude Code
  or Codex sessions, memory or settings, only the empty temp ones.
- Welcome → Continue → **Skip for now** (local mode), then creates project
  **Lanework** (slug `lanework`) and links `--folder` (default: this repo)
  through the folder-chooser seam `LANEWORK_TEST_FOLDERS`.
- `--gh missing` points `LANEWORK_GH_PATH` at nothing; `--gh loggedout` wraps
  the real `gh` with an empty config until the `gh-login` command;
  `--gh offline` answers every call with gh's "error connecting" text.

## Commands

| Command | Does |
| --- | --- |
| `goto <path>` | `app://lanework<path>`, e.g. `/w/lanework/changes`, `/settings/projects` |
| `click <text>` | first element with that text (`/regex/i` works) |
| `button <name>` / `tab <name>` | by ARIA role and accessible name |
| `fill "<label>" <value>` | type into a labelled field |
| `press <key>` | e.g. `ControlOrMeta+n` |
| `wait <ms>` | `gh` reads take seconds; wait before `shot` |
| `shot <name>` | screenshot to `--shots` (default `/tmp/run-desktop`). Read the PNG |
| `text [after]` | window text, from the last match of `after` (1500 chars) |
| `eval <js>` / `url` / `errors` | page JS, current URL, page errors so far |
| `home` | the temp app home, and whether its `git/` folder exists |
| `gh-login` | with `--gh loggedout`: `gh` answers as the real login from now on |
| `quit` | close the app |

## Gotchas

- Slug is `lanework` after setup; routes are `/w/lanework/<screen>`.
- Wheel scrolling does not reach nested panes. Collapse sections (e.g.
  `button Description`) or use `text <heading>` to read below the fold.
- The CSP blocks remote images (`img-src 'self' data:`), so GitHub avatars log
  console errors. That is expected, not a failure.
