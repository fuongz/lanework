<div align="center">

# 🗂️ Lanework

**Visualize your AI coding agent's review checklists as a Kanban board.**

The markdown review files your agent writes to `.agents/reviews/` render as a live
board — grouped by status, with priority, assignees, tags, and checklist progress.
Run it **hosted** (sign in with GitHub, pick any repo) or **locally** against the
repo you're in (`npx @phake/lanework`, no auth, no network).

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

The **hosted** app is read-only — it reads `.agents/reviews/` and never writes back.
The **local CLI** reads the same way, but lets you tick checkboxes in a review and
**Save changes** back to the file on disk when you choose to.

## Two ways to use it

| | Hosted (`apps/webapp`) | Local CLI (`apps/local`) |
| --- | --- | --- |
| Runs on | Cloudflare Workers (lanework.dev) | Your machine (`npx @phake/lanework`) |
| Source | A GitHub repo (any branch) | The current directory on disk |
| Auth | GitHub sign-in (Better Auth) | None |
| Network | Reads GitHub REST + GraphQL | Fully offline |
| Live updates | Manual refresh (KV-cached) | Auto — watches the folder |
| Checklists | Read-only | Tick boxes + **Save changes** to disk |
| Cost view | — | Estimates Claude Code token spend from `~/.claude` |

Both share the same UI and review-parsing logic (in `packages/shared`).

## Features

- 🗂️ **Board & List views** — four columns from `.agents/reviews/{todo,processing,done,dropped}`
- 🏷️ **Rich cards** — priority, assignee avatars, tags, date, and an `x/x` checklist-progress badge
- 🔎 **Filter** by **tag** or **My tasks**, with a searchable repo switcher (hosted)
- 📄 **Full-screen review** with a clean metadata panel + rendered markdown
- ☑️ **Interactive checklists** — tick items in a review with live progress; **"pick one"** groups render as radios
- 💾 **Save to disk** (local CLI) — persist your ticks back to the markdown file
- 💰 **Cost view** (local CLI) — estimates the project's Claude Code token spend from `~/.claude` transcripts, with a cache-aware per-model breakdown
- 💻 **Local CLI** — `npx @phake/lanework` boards the current repo, no Cloudflare or auth, with live file-watch
- 🔐 **GitHub sign-in** (hosted) — pick any repo you can access
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
See the in-app **[guide](packages/shared/src/routes/guide.tsx)** or the standardized
**[`AGENTS.md`](./AGENTS.md)** template to set this up in your own repos.

## Run locally on any repo

No install, no config — point it at a repo that has an `.agents/reviews/` folder:

```bash
npx @phake/lanework               # boards the current directory
bunx @phake/lanework              # same, with Bun
npx @phake/lanework path/to/repo  # board a different directory
```

It picks a free port (from `3662`), serves on `127.0.0.1`, and opens your browser.
Edit or add review files and the board updates live. Open a review to tick its
checkboxes — they're a working view until you hit **Save changes**, which writes the
updated markdown back to the file on disk.

```
lanework [dir] [--port N] [--no-open]
```

After a global install (`npm i -g @phake/lanework`) the commands **`lanework`** and
the short alias **`lw`** are available everywhere.

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (React 19, SSR, server functions) |
| Hosting | [Cloudflare Workers](https://workers.cloudflare.com/) (`@cloudflare/vite-plugin` + Wrangler) |
| Auth | [Better Auth](https://better-auth.com) — GitHub OAuth, sessions in Cloudflare **D1** via Drizzle |
| Data | GitHub REST + GraphQL (`packages/shared/src/lib/github.ts`) or the local filesystem (`local-fs.ts`) |
| UI | Tailwind CSS v4, shadcn over Base UI, Hugeicons, Motion |
| State | Zustand |
| Monorepo | Bun workspaces |

## Monorepo layout

```
packages/shared/             all shared app code (one copy of the UI)
└── src/
    ├── routes/              TanStack routes (__root, index, guide, board.$owner.$repo)
    ├── components/          ui/, kanban/, app-shell, app-sidebar, switchers
    ├── server/reviews.ts    server functions (branch on __LANEWORK_LOCAL__)
    ├── lib/                 github, reviews-core (shared parsing), local-fs,
    │                        auth, db (Drizzle), utils, formatting
    ├── stores/              Zustand UI state
    └── content/             the standardized AGENTS.md template

apps/webapp/                 hosted target → lanework.dev
├── vite.config.ts           Cloudflare build (srcDirectory → ../../packages/shared/src)
├── wrangler.jsonc, drizzle/ platform config + D1 migrations
└── worker-configuration.d.ts

apps/local/                  the `lanework` CLI (publishable to npm)
├── cli.mjs                  port selection + auto-open browser
├── server.mjs               srvx server: static assets, SSR, live-watch SSE
├── vite.config.local.ts     Node build (no Cloudflare; cloudflare:workers shimmed)
└── cloudflare-workers-shim.ts
```

Both apps point the route scanner at `packages/shared/src`. The filesystem code is
gated behind a build-time `__LANEWORK_LOCAL__` flag, so it's dead-code-eliminated
from the Cloudflare Worker.

## Develop the hosted app

> Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
cp apps/webapp/.dev.vars.example apps/webapp/.dev.vars   # fill in the secrets (below)
cd apps/webapp && bunx wrangler d1 create lanework-db    # paste database_id into wrangler.jsonc
cd ../.. && bun run db:migrate:local
bun run dev                                              # http://localhost:5173
```

You'll need a **GitHub OAuth App** (dev) with callback
`http://localhost:5173/api/auth/callback/github`, then set in `apps/webapp/.dev.vars`:

```ini
BETTER_AUTH_SECRET=...   # openssl rand -base64 32
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

> The app requests the `repo` scope to read private repos — change it to
> `public_repo` in `packages/shared/src/lib/auth.ts` if you only need public ones.

To run the **local** target during development (boards the current directory):

```bash
bun run local            # builds apps/local and launches it
```

## Deploy (Cloudflare)

```bash
bun run cf-typegen
bun run db:migrate:remote
cd apps/webapp
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
cd ../.. && bun run deploy
```

Create a **separate prod OAuth App** (a classic OAuth App matches the callback by
exact host, so dev `localhost` and prod can't share one) with your Worker's domain
in both URLs, set `BETTER_AUTH_URL` in `apps/webapp/wrangler.jsonc`, and redeploy.
Since the Worker URL isn't known until the first deploy: deploy once → note the URL
→ create the prod app + secrets → redeploy.

## Publish the CLI to npm

The CLI is published as **`@phake/lanework`** from `apps/local`. It ships the
prebuilt app (`dist-local`), so it runs anywhere with no build step for consumers;
`prepack` rebuilds the bundle automatically before packing. Scoped packages are
private by default, so `publishConfig.access` is set to `public`.

```bash
# 1. From the repo root, install so the build toolchain is available
bun install

# 2. Log in to npm (needs an account that belongs to the `phake` org;
#    prompts for an OTP if 2FA is on)
npm login

# 3. (For later releases) bump the version — npm versions are immutable
cd apps/local
npm version patch            # 0.1.0 → 0.1.1   (skip for the very first publish)

# 4. Sanity-check what will ship, then publish (public, thanks to publishConfig)
npm publish --dry-run
npm publish

# 5. Verify
cd ~/any-repo && npx @phake/lanework
```

The **`phake` org must exist on npm** with your account as a member
([create it here](https://www.npmjs.com/org/create) if needed). Only `apps/local`
is published — `apps/webapp`, `packages/shared`, and the workspace root are all
`private`.

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
