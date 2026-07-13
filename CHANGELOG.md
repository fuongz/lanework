# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.6] - 2026-07-13

### Added
- **`--reviews-dir` flag / `LANEWORK_REVIEWS_DIR` env var** — board a reviews
  folder other than the default `.agents/reviews`, relative to the repo root or
  absolute (`lanework --reviews-dir .custom/reviews`). Works for the dashboard,
  `lanework mcp`, and dispatched agent runs alike.

## [0.3.5] - 2026-07-07

### Added
- **`date.pattern` config option** — `.agents/reviews/config.json` can now declare
  an extra date pattern (a regex source string with named `year`/`month`/`day`
  groups) for filenames, folders, and frontmatter date values that don't use the
  built-in `YYYY-MM-DD` shape, e.g. a compact `YYYYMMDD` prefix from a `task_id`
  convention. The built-in `YYYY-MM-DD` match is always tried first; an invalid or
  incomplete pattern is ignored rather than erroring.
- **Custom frontmatter fields in the review dialog** — any frontmatter key the
  board doesn't otherwise read (e.g. a repo's own `task_id`, `phase`, `gate`)
  now shows up as its own row in the card detail view instead of being silently
  dropped.

### Fixed
- **Broken assignee avatars** — a GitHub avatar `<img>` that 404s (e.g. the login
  isn't a real GitHub user) now falls back to a deterministic gradient + initial
  avatar instead of the browser's broken-image icon.
- **Inaccurate checklist counter removed** — the per-checklist "N of M" header
  counter (and the live-count store that only existed to feed it) is gone; the
  Checklist card header now just shows the label.
- **Unchecked checkbox styling** — the unchecked state changed from a gray fill
  to a white/background fill with a visible border, matching the checked state's
  visual weight instead of reading as disabled.

## [0.3.4] - 2026-07-03

### Fixed
- **`status.values` aliases didn't apply to folder names** — `resolveCardLocation`
  only ran the alias check against the frontmatter `status:` field; in folder mode
  (or the frontmatter-mode folder-date fallback), a column folder renamed e.g.
  `done/` → `completed/` was silently dropped from the board instead of resolving
  to `done`. Both paths now go through the same alias resolver.

## [0.3.3] - 2026-07-03

### Added
- **Custom status vocabulary** — `.agents/reviews/config.json` gained
  `status.values` (extra words a file's `status:` field can use, mapped onto
  the four canonical columns) and `status.labels` (what the board displays for
  each column), so a client whose files say `status: In Review` or `Shipped`
  reads and displays correctly without touching the underlying lifecycle. The
  MCP `create_review`/`set_status` tools accept these words too.

## [0.3.2] - 2026-07-02

### Fixed
- **Broken `npx @phake/lanework`** — the published 0.3.1 package was missing
  `agent-runner.mjs` (not listed in `files`), so `server.mjs`'s dynamic import of it
  failed with `ERR_MODULE_NOT_FOUND` for every fresh install. Added it to `files`.

## [0.3.1] - 2026-06-30

### Added
- **Agent run telemetry on the card** — when a dispatched agent finishes, what the
  run cost is written back into the review `.md`: structured `last_run_*` keys in the
  frontmatter (latest run) plus a row in a human-readable `## Agent runs` history table.
- **Run cost in the UI** — a result-colored cost badge on the board card, and a "Last
  run" row (result · runtime · tokens · ~$) in the review dialog's meta panel.
- **Pick model · effort · mode per run** — the review dialog, the create-task dialog,
  and the card's Run button now offer selectors that map to `claude --model` /
  `--effort` (plus implement/plan mode); choices persist across sessions.
- **`plan_review` MCP tool** — the planning agent fills a card's checklist through a
  structured tool that composes the canonical house format (frontmatter preserved,
  `## Decisions` as `- [ ] **Dn.** …`) instead of free-form `save_review`.
- **Live review dialog** — an open card re-fetches its body when the file changes (e.g.
  an agent just wrote its run telemetry), so the `## Agent runs` table updates without
  reopening. Skipped while you have unsaved edits.

### Changed
- **Refreshed board design (Height/Linear-style)** — white cards float on a layered-gray
  canvas (sidebar < canvas < cards), columns are unboxed with a status-circle header +
  count pill, cards get a tighter radius, hairline border, and soft hover shadow, and the
  board toolbar right-aligns the view switcher + a renamed **New task** action.

### Fixed
- **Per-checklist progress** counts each checklist independently (live `x of x` ring,
  solid checkmark at 100%), and the card's Run-options popover no longer opens the task
  detail dialog when you use its selects.

## [0.3.0] - 2026-06-29

### Added
- **Local agent orchestration** — run an agent directly against a review card from the
  board (and a Todoist-style card layout to drive it). The hosted webapp is paused in
  favour of the local-first flow.
- **Claude usage costs + git branch in the sidebar** — surface per-run cost estimates and
  the active branch alongside the board.

### Changed
- **Board + checklist UI polish** across the card and review dialog.

### Fixed
- **Per-checklist live progress** — each checklist header now shows its own `x of x`
  count with a progress ring that fills as boxes are ticked (and a solid checkmark at
  100%), instead of a static seed or the whole document's combined total. "Pick one"
  radio groups collapse to a single item.

## [0.2.3] - 2026-06-29

### Changed
- **The Claude Code plugin is now the recommended install everywhere** — it provides
  both the `/lanework:*` slash commands and the MCP server in one step:
  `claude plugin marketplace add fuongz/lanework` → `claude plugin install lanework@lanework`.
  `npx @phake/lanework setup claude-code` remains as an MCP-tools-only path (no slash
  commands). Landing, guide, and READMEs updated accordingly.

## [0.2.2] - 2026-06-29

### Changed
- **The board now opens by default** when the MCP server starts (Serena-style):
  `npx @phake/lanework setup claude-code` and the Claude Code plugin boot the web board
  (≈ `:3662`) whenever Claude Code starts. Run headless with
  `npx @phake/lanework setup claude-code --no-dashboard`, or set `LANEWORK_DASHBOARD=0` in the
  plugin server's env.

## [0.2.1] - 2026-06-29

### Added
- **Auto-open the board on Claude Code startup (Serena-style)** —
  `npx @phake/lanework setup claude-code --dashboard` registers the MCP server so it also boots
  the web board (≈ `:3662`) whenever Claude Code starts. Plugin users can opt in with
  `LANEWORK_DASHBOARD=1` in the server env. Headless remains the default.

### Changed
- The marketing landing (`/`) is now fully static — no server-side calls in the cloud
  build. The authenticated repository list moved to a new **`/dashboard`** route; sign-in
  lands there. Landing + guide gained MCP / AI-DLC sections.

## [0.2.0] - 2026-06-29

### Added
- **Flexible review layouts** — alongside the flat `<status>/YYYY-MM-DD-<slug>.md`
  convention, files can now be grouped in date folders as
  `<status>/YYYY-MM-DD/NN-<slug>.md`: the date comes from the folder and the leading
  `NN-` orders cards within the day (a new `ordinal` sort key).
- **Status from frontmatter (new default)** — a card's column now comes from its
  `status:` field, falling back to the containing column folder (so existing
  folder-based boards keep working). Set `{"status":{"from":"folder"}}` in
  `.agents/reviews/config.json` to make folders authoritative instead.
- **Custom frontmatter keys** — a `fields` map in `config.json` aliases your own
  keys onto card fields, e.g. `{"fields":{"assignees":["owner"],"tags":["labels"]}}`;
  the canonical key always keeps working.
- **AI-DLC MCP server** — `lanework mcp` gains workflow-aware tools that drive the
  full review lifecycle: `create_review` (inception), `toggle_item` (approve), `set_status`
  (advance todo → processing → done, honouring frontmatter vs. folder mode),
  `update_review`, and `lifecycle_status` (phase view + suggested next actions) — joining
  the existing `list_reviews`, `get_review`, `board_summary`, `save_review`, `cost_estimate`.
- **Claude Code plugin** — installable via `claude plugin marketplace add fuongz/lanework`,
  bundling the MCP server plus `/lanework:{create,status,review,advance,tick}` slash
  commands. A launcher prefers a local build and falls back to the published package.
- **`npx @phake/lanework setup claude-code`** — one-command MCP registration (Serena-style) that
  wraps `claude mcp add`, with `--project` and `--local` variants.
- **Guide & docs** — `/guide` and the `AGENTS.md` template document the new default
  layout, the `config.json` options, a frontmatter field reference, and key aliasing.

### Changed
- The zero-config default for deriving a card's column is now the `status:` frontmatter
  field (with folder fallback) instead of strictly the folder name. Pure folder boards
  with no `status:` field are unaffected.

## [0.1.2] - 2026-06-26

### Added
- **Local-first `lanework` CLI** (`@phake/lanework`) — boards the current repo's
  `.agents/reviews/` straight off disk; no Cloudflare, no auth, no network. Picks a
  free port (from `3662`), serves on `127.0.0.1`, auto-opens the browser, and
  live-watches the folder. Split the codebase into a Bun workspace
  (`packages/shared` + `apps/{webapp,local}`).
- **Interactive checklists** — tick `- [ ]` items in the review dialog with live
  progress and a "Ready" state at 100%. In the local CLI, **Save changes** writes the
  edits back to the markdown file on disk; a circular ring on the button shows readiness.
- **"Pick one" groups** — options nested under a `Pick one:` bullet render as
  mutually-exclusive radios (selecting one clears the rest). Documented in the
  `AGENTS.md` template and `/guide`.
- **`x/x` progress badges** — color-coded done/total on each card and an aggregate on
  the board header; "pick one" groups collapse to a single decision in the count.
- **Cost view** (local CLI only) — estimates the project's Claude Code token spend by
  reading `~/.claude/projects/` transcripts, with a cache-aware per-model breakdown
  (cache reads 0.1×, writes 1.25–2× input — verified against Claude's pricing docs).
  Lives in the sidebar.
- **Per-view routes** — `/board/$owner/$repo/{board,list}` plus
  `/board/$owner/$repo/cost`, with a segmented icon tab bar.
- Redesigned **List view** (grouped status sections, aligned columns, staggered Motion
  entrance) and assignee **avatar + username** pills on cards.
- **KV-cached** GitHub board fetch with a "last fetched" badge and manual refresh;
  searchable **branch switcher**; single-fetch repo store with in-UI pagination/search.

### Changed
- Default local CLI port is now `3662`.

## [0.1.0] - 2026-06-22

### Added
- GitHub sign-in via Better Auth, with sessions in Cloudflare D1 (Drizzle adapter).
- Kanban **Board** and **List** views of a repo's `.agents/reviews/` folder
  (To-Do / In Progress / Done / Dropped).
- Rich cards: priority, assignee avatars, tags, date, and checklist progress —
  parsed from each review's YAML frontmatter and `- [ ]` / `- [x]` checkboxes.
- File contents batch-fetched via GitHub GraphQL for fast board loads.
- Searchable **repo switcher** and persistent sidebar with **Main** (Tasks / My
  tasks) and **Tags** sections (top 5 + searchable "More").
- Full-screen **review dialog** with a metadata panel and rendered markdown.
- Filtering by **tag** and **My tasks** via URL search params.
- Instant **skeleton loading** state for the board route.
- **Motion** animations (staggered entrance, layout/exit on filter) with
  `prefers-reduced-motion` support.
- In-app **guide** (`/guide`) and a standardized **`AGENTS.md`** template.
- **Design System** documentation under `docs/design-system/`.

[Unreleased]: https://github.com/fuongz/lanework/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/fuongz/lanework/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/fuongz/lanework/releases/tag/v0.1.0
