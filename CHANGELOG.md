# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-06-29

### Changed
- **The board now opens by default** when the MCP server starts (Serena-style):
  `lanework setup claude-code` and the Claude Code plugin boot the web board
  (≈ `:3662`) whenever Claude Code starts. Run headless with
  `lanework setup claude-code --no-dashboard`, or set `LANEWORK_DASHBOARD=0` in the
  plugin server's env.

## [0.2.1] - 2026-06-29

### Added
- **Auto-open the board on Claude Code startup (Serena-style)** —
  `lanework setup claude-code --dashboard` registers the MCP server so it also boots
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
- **`lanework setup claude-code`** — one-command MCP registration (Serena-style) that
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
