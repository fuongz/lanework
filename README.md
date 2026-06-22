<div align="center">

# 🗂️ Lanework

**Visualize your AI coding agent's review checklists as a Kanban board.**

Sign in with GitHub, pick a repo, and the markdown review files your agent writes to
`.agents/reviews/` render as a live board — grouped by status, with priority,
assignees, tags, and checklist progress.

[![CI](https://github.com/fuongz/lanework/actions/workflows/ci.yml/badge.svg)](https://github.com/fuongz/lanework/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](./LICENSE)
[![Built with TanStack Start](https://img.shields.io/badge/TanStack-Start-emerald.svg)](https://tanstack.com/start)
[![Deploy: Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)

</div>

<!-- Add a screenshot/GIF of the board here once available:
<p align="center"><img src="docs/assets/board.png" alt="Lanework board" width="900"></p>
-->

## Why

AI coding agents (Claude Code, Codex, Cursor, …) increasingly write **review
checklists** before changing behavior — a markdown file with `- [ ]` items you
approve before they implement. Lanework turns that convention into a board so
you can see, across a repo, what's awaiting review, in progress, done, or dropped —
and open any review to read and approve it.

It's **read-only**: it reads from GitHub and never writes back to your repos.

## Features

- 🔐 **GitHub sign-in** (Better Auth) — pick any repo you can access
- 🗂️ **Board & List views** — four columns from `.agents/reviews/{todo,processing,done,dropped}`
- 🏷️ **Rich cards** — priority, assignee avatars, tags, date, and live checklist progress
- 🔎 **Filter** by **tag** or **My tasks** (assigned to you), with a searchable repo switcher
- 📄 **Full-screen review** with a clean metadata panel + rendered markdown
- ⚡ **Fast** — file contents batched via GitHub GraphQL; instant skeleton loading
- ✨ **Polished** — Motion animations, Hugeicons, shadcn/Base UI, dark-mode tokens
- 📘 **Built-in guide** (`/guide`) explaining how to set up the convention in any repo

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
See the in-app **[guide](src/routes/guide.tsx)** or the standardized
**[`AGENTS.md`](./AGENTS.md)** template to set this up in your own repos.

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (React 19, SSR, server functions) |
| Hosting | [Cloudflare Workers](https://workers.cloudflare.com/) (`@cloudflare/vite-plugin` + Wrangler) |
| Auth | [Better Auth](https://better-auth.com) — GitHub OAuth, sessions in Cloudflare **D1** via Drizzle |
| Data | GitHub REST + GraphQL (`src/lib/github.ts`) |
| UI | Tailwind CSS v4, shadcn (`base-lyra`) over Base UI, Hugeicons, Motion |
| State | Zustand |

## Quick start

> Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
cp .dev.vars.example .dev.vars      # then fill in the secrets (see below)
bunx wrangler d1 create lanework-db   # paste database_id into wrangler.jsonc
bun run db:migrate:local
bun run dev                          # http://localhost:5173
```

You'll need a **GitHub OAuth App** (dev) with callback
`http://localhost:5173/api/auth/callback/github`, then set in `.dev.vars`:

```ini
BETTER_AUTH_SECRET=...   # openssl rand -base64 32
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

> The app requests the `repo` scope to read private repos — change it to
> `public_repo` in `src/lib/auth.ts` if you only need public ones.

## Deploy (Cloudflare)

```bash
bun run cf-typegen
bun run db:migrate:remote
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bun run deploy
```

Create a **separate prod OAuth App** (a classic OAuth App matches the callback by
exact host, so dev `localhost` and prod can't share one) with your Worker's domain
in both URLs, set `BETTER_AUTH_URL` in `wrangler.jsonc`, and redeploy. Since the
Worker URL isn't known until the first deploy: deploy once → note the URL → create
the prod app + secrets → redeploy.

## Project layout

```
src/
├── routes/                       TanStack routes
│   ├── __root.tsx                document shell + providers
│   ├── index.tsx                 landing + projects home
│   ├── guide.tsx                 "How to use" docs page
│   ├── board.$owner.$repo.tsx    the board (+ pending skeleton)
│   └── api/auth/$.ts             Better Auth handler
├── components/
│   ├── ui/                       shadcn / Base UI primitives (+ svgs/)
│   ├── kanban/                   board, column, card, review dialog, skeleton
│   ├── app-shell.tsx             sidebar + main frame
│   ├── app-sidebar.tsx           repo switcher, nav, tags, account
│   └── repo-switcher.tsx, tag-more.tsx
├── server/reviews.ts             server functions (getRepos, getBoard, …)
├── lib/                          auth, github, db (Drizzle), utils, formatting
├── stores/board-store.ts         Zustand UI state
└── content/agents-template.ts    the standardized AGENTS.md template
```

## Documentation

- **[Design System](./docs/design-system/README.md)** — tokens, components, patterns, animation, layout
- **[`AGENTS.md`](./AGENTS.md)** — how AI agents should work in this repo (and the convention this app renders)
- **[Contributing](./CONTRIBUTING.md)** · **[Code of Conduct](./CODE_OF_CONDUCT.md)** · **[Security](./SECURITY.md)**

## Contributing

Contributions are welcome! Please read **[CONTRIBUTING.md](./CONTRIBUTING.md)** and
the **[Design System docs](./docs/design-system/README.md)** before opening a PR.
Run `bun run typecheck && bun run build` before pushing.

## License

[MIT](./LICENSE) © fuongz
