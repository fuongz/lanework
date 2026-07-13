# 🗂️ lanework

**Run your AI coding agent's review checklists as a local Kanban board — no
Cloudflare, no auth, no network.**

Your agent (Claude Code, Codex, Cursor, …) writes review checklists as markdown
to `.agents/reviews/`. `lanework` reads that folder straight off disk and renders
it as a live board you can browse, tick, and save — all on `127.0.0.1`.

```bash
npx @phake/lanework               # board the current directory
bunx @phake/lanework              # same, with Bun
npx @phake/lanework path/to/repo  # board a different repo
```

It picks a free port (starting at `3662`), serves on `127.0.0.1`, and opens your
browser. Edit or add review files and the board updates live.

After a global install (`npm i -g @phake/lanework`) the commands **`lanework`** and
the short alias **`lw`** are available everywhere.

```
lanework [dir] [--port N] [--no-open] [--reviews-dir PATH]
```

| Flag | Effect |
| --- | --- |
| `dir` | Repo to board (defaults to the current directory). Pass the **repo root**, not the `.agents/reviews` path. |
| `--port N`, `-p N` | Preferred starting port (falls back upward if taken). Default `3662`. |
| `--no-open` | Don't auto-open the browser. |
| `--reviews-dir PATH` | Board a non-default reviews folder — relative to `dir`, or absolute (e.g. `--reviews-dir .custom/reviews`). Same as setting `LANEWORK_REVIEWS_DIR`. Default: `.agents/reviews`. |

## MCP server — drive the lifecycle (AI-DLC)

`lanework mcp` runs a Model Context Protocol server (stdio) so an AI client can **drive
the whole review lifecycle** — not just read it. It speaks an AI-Driven Development
Lifecycle: **inception** (`create_review` → a `todo` checklist of decisions) → **review**
(`toggle_item` ticks each decision) → **construction & shipping** (`set_status` advances
`todo → processing → done`, or `dropped`).

```bash
lanework mcp [dir]                        # MCP server only, no browser (headless / CI)
lanework mcp --dashboard                  # MCP server + the web board (a live "dashboard")
lanework mcp --reviews-dir .custom/reviews  # board a non-default reviews folder
```

### Install into Claude Code

Install the lanework **plugin** — it gives you the `/lanework:*` slash commands **and** the
MCP server in one step:

```bash
claude plugin marketplace add fuongz/lanework
claude plugin install lanework@lanework
```

Restart Claude Code, then type `/lanework:` — `/lanework:create`, `/lanework:status`,
`/lanework:review`, `/lanework:advance`, `/lanework:tick`. The server runs headless by
default (tools only); set `LANEWORK_DASHBOARD=1` in the server env to also auto-open the
web board (≈ `:3662`) when a session starts. (Each Claude Code session starts its own
board; the port climbs from `3662` if one's busy.) See [`plugin/README.md`](../../plugin/README.md).

> Just want the MCP **tools** (no slash commands)? Register the server on its own:
> `npx @phake/lanework setup claude-code` (add `--dashboard` to auto-open the board, `--local` to
> use this build).

### Tools

| Tool | What it does |
| --- | --- |
| `lifecycle_status` | Phase view + **suggested next actions** (which cards are ready to advance). |
| `list_reviews` | List cards; filter by `column`, `tag`, or `assignee`. |
| `get_review` | Read one card's full markdown. |
| `board_summary` | Counts per column + aggregate checklist progress. |
| `create_review` | Inception — new checklist card (`title`, `priority`, `tags`, `assignees`, `date`, `body`). |
| `toggle_item` | Check/uncheck a checklist item by `index` or `match`, with an optional `> note`. |
| `set_status` | Advance the column. Frontmatter mode edits `status:`; folder mode moves the file. |
| `update_review` | Patch `priority` / `tags` / `assignees`. |
| `save_review` | Raw whole-file write (escape hatch — prefer the tools above). |
| `cost_estimate` | Per-model Claude Code token usage from local `~/.claude` transcripts. |

All tools honour the layout/config below (date folders, frontmatter `status:`, field aliases).

## What it does

- 🗂️ **Board & List views** from your `.agents/reviews/` markdown (column from each
  card's `status:` field, or from `todo/processing/done/dropped` folders — see below).
- 🏷️ **Rich cards** — priority, assignees, tags, date, and an `x/x` checklist-progress badge.
  Any frontmatter key the board doesn't otherwise map (e.g. your own `task_id`, `phase`,
  `gate`) shows up as its own row in the card's detail view instead of being dropped.
- ☑️ **Interactive checklists** — tick `- [ ]` items right in the full-screen review,
  with live progress and a "Ready" state at 100%.
- 🔘 **"Pick one" groups** — options nested under a `Pick one:` bullet render as radio
  buttons (selecting one clears the others).
- 💾 **Save to disk** — your ticks are a local working view until you hit **Save changes**,
  which writes the updated markdown back to the file. (Local mode only.)
- 💰 **Cost view** — estimates what the project has cost in Claude Code tokens by reading
  your local `~/.claude` session transcripts (per-model breakdown, cache-aware pricing).
  Lives in the sidebar; local mode only.
- 🔄 **Live file-watch** — add or edit review files and the board refreshes automatically.

## How it maps

By default each card declares its **column** with a `status:` field, and files are
grouped by date:

```
<repo>/.agents/reviews/
└── 2026-06-21/                           → a date folder (the card's date)
      ├── 01-ship-landing.md              # ── frontmatter: status: done
      └── 02-bulk-send-message.md         # ── frontmatter: status: processing
```

A card reads its **column** from the `status:` field, its **date** from the enclosing
`YYYY-MM-DD/` folder (the leading `NN-` orders cards within that day), and
**priority · assignees · tags · progress** from the rest of the YAML frontmatter + its
`- [ ]` / `- [x]` checkboxes. `status:` must be one of `todo · processing · done ·
dropped`; if it's missing the card falls back to its folder, then to `todo`.

### Alternative: status from the folder

Prefer folders to carry the status? Drop the `status:` field and put files in
`todo/ processing/ done/ dropped/` folders instead — flat or with date subfolders:

```
<repo>/.agents/reviews/
├── todo/        → "To-Do" column
├── processing/  → "In Progress" column
├── done/        → "Done" column
└── dropped/     → "Dropped" column
        ├── 2026-06-21-bulk-send-message.md       → a card (flat)
        └── 2026-06-21/01-retry-failed-sends.md   → a card (date folder)
```

This works out of the box (the folder sets the column). To make folders **authoritative**
and ignore any stray `status:` field, add `<repo>/.agents/reviews/config.json`:

```json
{ "status": { "from": "folder" } }
```

Both layouts can coexist.

### Customize frontmatter keys

Already use your own frontmatter terms (e.g. `owner` instead of `assignees`, `labels`
instead of `tags`)? Map them to card fields in `<repo>/.agents/reviews/config.json`:

```json
{
  "fields": {
    "assignees": ["owner"],
    "tags": ["labels"],
    "priority": ["prio"],
    "created_at": ["due", "date"],
    "status": ["state"]
  }
}
```

Each value lists the frontmatter keys to accept for that field; the first one present in
a file wins. The canonical key (`assignees`, `tags`, …) always keeps working, so adding
an alias never breaks existing files.

### Customize date parsing

Filenames, date folders, and `created_at`-style values must be `YYYY-MM-DD` by default.
If your convention encodes dates differently — e.g. a compact `YYYYMMDD` prefix from a
`task_id` like `2026-0707-rd16-slug` — add a `date.pattern` to
`<repo>/.agents/reviews/config.json`: a regex source string with named `year`/`month`/`day`
groups, tried whenever the built-in `YYYY-MM-DD` match fails:

```json
{ "date": { "pattern": "(?<year>\\d{4})-(?<month>\\d{2})(?<day>\\d{2})" } }
```

An invalid pattern (bad regex, or missing one of the three named groups) is ignored — only
the built-in match is tried.

## Setting up the convention

To get your agent producing these files, drop the standardized
[`AGENTS.md`](https://github.com/fuongz/lanework/blob/main/AGENTS.md) template into
your repo. The board's built-in **/guide** page explains the format, including how to
write mutually-exclusive **"pick one"** decisions:

```md
- **D2. Counter backend — Pick one:**
  - [ ] **D2.A (Recommended)** In-memory sliding window — single region.
  - [ ] **D2.B** Durable Object counter — multi-region, more infra.
- [ ] **D3.** For D2.A: document the single-region limitation.   ← independent
```

## Privacy

Fully offline: no auth, no telemetry, no network calls. It reads (and, on **Save
changes**, writes) files under the `.agents/reviews/` folder of the directory you point
it at. The **Cost view** additionally reads this project's Claude Code session
transcripts under `~/.claude/projects/` to total token usage — read-only, never written,
and never leaves your machine.

## Links

- **Hosted version & source:** <https://github.com/fuongz/lanework>
- **License:** [MIT](https://github.com/fuongz/lanework/blob/main/LICENSE) © fuongz
