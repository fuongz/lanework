# Contributing

Thanks for your interest in improving Lanework! This guide covers local
setup, the workflow, and what we expect in a PR.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- A GitHub OAuth App for local dev (see the [README](./README.md#quick-start))
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `bun install`)

## Local setup

```bash
bun install
cp .dev.vars.example .dev.vars      # fill in BETTER_AUTH_SECRET + GitHub OAuth creds
bunx wrangler d1 create lanework-db   # paste database_id into wrangler.jsonc
bun run db:migrate:local
bun run dev
```

## Project conventions

This repo follows its own agent workflow — see **[`AGENTS.md`](./AGENTS.md)**. Even
as a human contributor, please respect:

- **Read [`docs/design-system/`](./docs/design-system/README.md) before any UI change.**
  Reuse the documented tokens, primitives (`src/components/ui/`), and patterns. If
  you introduce a new reusable pattern, update the relevant doc in the same PR.
- Use **tokens, not literals** (`bg-card`, `text-muted-foreground`, …).
- Icons via **Hugeicons** (`@hugeicons/react`), never `lucide-react`.
- Animations via **Motion** (`motion/react`); keep them subtle and behind
  `reducedMotion`.
- Never edit generated files: `src/routeTree.gen.ts`, anything under `drizzle/`,
  or `worker-configuration.d.ts`. For schema changes, edit `src/lib/db/schema.ts`
  then run `bun run db:generate`.
- All GitHub access stays **server-side** (`src/lib/github.ts`); tokens must never
  reach the client.

## Before you push

```bash
bun run typecheck     # tsc --noEmit
bun run build         # vite build (client + SSR)
```

Both must pass. For behavior changes, boot the app (`bun run dev`) and verify the
flow manually. CI runs the same checks on every PR.

## Pull requests

1. Fork and create a topic branch (`feat/...`, `fix/...`, `docs/...`).
2. Keep PRs focused; describe **what** and **why**, and how you verified.
3. Reference any related issue (`Closes #123`).
4. Make sure typecheck + build pass and docs are updated where relevant.

### Commit messages

Conventional Commits are appreciated but not required:

```
feat(board): add tag filter to the sidebar
fix(auth): refresh GitHub token before listing repos
docs(design-system): document tag pill colors
```

## Reporting bugs / requesting features

Use the [issue templates](https://github.com/fuongz/lanework/issues/new/choose).
For security issues, **do not** open a public issue — see [SECURITY.md](./SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
