# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/fuongz/lanework/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fuongz/lanework/releases/tag/v0.1.0
