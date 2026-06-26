# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
