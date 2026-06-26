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
lanework [dir] [--port N] [--no-open]
```

| Flag | Effect |
| --- | --- |
| `dir` | Repo to board (defaults to the current directory). Pass the **repo root**, not the `.agents/reviews` path. |
| `--port N`, `-p N` | Preferred starting port (falls back upward if taken). Default `3662`. |
| `--no-open` | Don't auto-open the browser. |

## What it does

- 🗂️ **Board & List views** from `.agents/reviews/{todo,processing,done,dropped}`.
- 🏷️ **Rich cards** — priority, assignees, tags, date, and an `x/x` checklist-progress badge.
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

```
<repo>/.agents/reviews/
├── todo/        → "To-Do" column
├── processing/  → "In Progress" column
├── done/        → "Done" column
└── dropped/     → "Dropped" column
        └── 2026-06-21-bulk-send-message.md   → a card
```

Each card reads its **column** from the folder, and **date · priority · assignees ·
tags · progress** from the file's YAML frontmatter + its `- [ ]` / `- [x]` checkboxes.

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
