# Instructions for AI agents

These guidelines define how AI agents (Claude Code, Codex, Cursor, …) should work
on this repository — **Lanework**, a TanStack Start app on Cloudflare Workers
that visualizes a GitHub repo's `.agents/reviews/` folder as a Kanban board.
Follow them for code-related tasks while respecting the user's latest explicit
instructions.

**Conflict order:** the user's latest explicit request wins, then the most
specific local repository instruction, then these general rules.

## Contents

- [Where artifacts go](#where-artifacts-go) — the `.agents/` layout
- [Fast Model Rules](#fast-model-rules) — condensed checklist
- [Workflow Orchestration](#workflow-orchestration) — the canonical, detailed rules
- [Domain Rules](#domain-rules) — Design System, TanStack Start, Cloudflare/D1, Auth, GitHub
- [Gotchas](#gotchas) — durable mistakes to avoid

---

## Where artifacts go

All agent working files live under `.agents/`. Use **`YYYY-MM-DD`** for every dated
filename (it sorts chronologically).

| Artifact | Path | When to write it |
| --- | --- | --- |
| Plan | `.agents/todo.md` | Before any substantial edit (3–5 concrete steps). |
| Review checklist | `.agents/reviews/YYYY-MM-DD/NN-<slug>.md` | Behavior-changing work with real design decisions. |
| Lesson | `.agents/lessons/YYYY-MM-DD/<slug>.md` | After a durable correction likely to recur. |
| Bug report | `.agents/bugs/YYYY-MM-DD/<slug>.md` | Ambiguous / recurring / production-impacting bug. |

For **read-only requests** (review, translation, explanation), do not create,
edit, or delete these files unless the user explicitly authorizes it.

> This app reads its own `.agents/reviews/**` convention — so the review files you
> write here are exactly what the board renders.

---

## Fast Model Rules

1. Decide whether the request is **read-only** or **requires edits**.
2. If read-only: don't create/edit/delete files unless explicitly authorized.
3. If it requires edits: write/update `.agents/todo.md` (3–5 steps) **before** substantial work.
4. **For any UI work, read `docs/design-system/` first** and reuse its tokens, components, and patterns.
5. Inspect only the files relevant to the task; make the smallest correct change that fits the existing style.
6. Verify: `bun run typecheck` and `bun run build` must pass; run/boot the app when behavior changes.
7. Report changed files, verification result, and remaining risk; end with a **"What's next for you"** handoff.

Fallback: if a tool, mode, or MCP server is unavailable, use the closest available
option and say so.

---

## Workflow Orchestration

### 1. Clarify Requirements and Plan
- Use Plan mode when available; otherwise write a brief concrete plan first.
- Write a plan to `.agents/todo.md` before substantial edits (unless read-only).
- Ask clarifying questions when the request is ambiguous, risky, or under-specified.
- Heavyweight analysis methods are **opt-in** — only when they clearly help.

### 2. Review Gate for Behavior-Changing Work

Before implementing behavior-changing work, write a review checklist to
`.agents/reviews/YYYY-MM-DD/NN-<slug>.md` and wait for the user to check every box.
**Implementation starts ONLY after all items are `[x]`.**

Each checklist has a **status** — its board column:

| `status` | Meaning |
| --- | --- |
| `todo` | Plan written, boxes not all checked — awaiting review. **New checklists start here.** |
| `processing` | Approved (all gating boxes `[x]`) and being implemented. |
| `done` | Shipped and verified. |
| `dropped` | Superseded or abandoned. |

**Default layout — status in frontmatter, files grouped by date:**
`.agents/reviews/YYYY-MM-DD/NN-<slug>.md`. The date comes from the `YYYY-MM-DD/` folder;
the leading `NN-` (`01`, `02`, …) orders cards within the day; the **column is the
`status:` field**. Advancing a review is a one-line `status:` edit — the file never moves.

**Frontmatter** (the board reads these): start each file with YAML, then `# Review: …`:

```yaml
---
status: todo                       # todo | processing | done | dropped
assignees: ["your-github-login"]
created_at: YYYY-MM-DD 00:00:00Z   # the date for this card
priority: medium                   # low | medium | high
tags: ["ui", "server-fn"]          # controlled vocabulary (see below)
---
```

**Alternative — status from the folder:** omit `status:` and place files in
`todo/ processing/ done/ dropped/` folders (flat `<status>/YYYY-MM-DD-<slug>.md` or
`<status>/YYYY-MM-DD/NN-<slug>.md`); the folder then sets the column. To make folders
authoritative and ignore any `status:` field, add `.agents/reviews/config.json` with
`{"status":{"from":"folder"}}`.

**Custom frontmatter keys:** a repo can map its own key names onto card fields via a
`fields` block in `config.json`, e.g.
`{"fields":{"assignees":["owner"],"tags":["labels"]}}` — the canonical key still works.
Keys the board doesn't map to a field (e.g. `task_id`, `phase`) are shown as-is, one row
per key, in the card detail dialog. **Dates in a non-`YYYY-MM-DD` shape** (e.g. a compact
`YYYYMMDD` prefix) need a `date.pattern` regex (named `year`/`month`/`day` groups) in
`config.json`, e.g. `{"date":{"pattern":"(?<year>\\d{4})-(?<month>\\d{2})(?<day>\\d{2})"}}`.
Tag vocabulary for this
repo: `ui`, `design-system`, `board`, `sidebar`, `dialog`, `animation`, `auth`,
`github`, `server-fn`, `d1`, `drizzle`, `routing`, `cloudflare`, `guide`, `docs`.
After the frontmatter add a "How to review" note (flip `- [ ]` → `- [x]`, write
`> notes` under disagreements), group items by topic, include Context, an explicit
**out of scope** section, and a **files touched** table. Mutually-exclusive options
are separate "pick ONE" boxes with a recommendation. Treat direct user edits to
the checklist as decisions.

What does NOT need one: read-only requests, single-file obvious fixes, UI work that
follows the documented design system, or tasks where the user specified the exact
shape. Those only need `.agents/todo.md`.

### 3. Subagent Strategy
- Use subagents only when the runtime allows them or the user asks.
- Offload bounded research/exploration; keep the critical implementation path in the main agent.

### 4. Self-Improvement Loop
- After a durable correction likely to recur, record it in `.agents/lessons/YYYY-MM-DD/<slug>.md`.
- Promote a recurring/repo-wide lesson into [Gotchas](#gotchas).

### 5. Verification Before Done
- Never mark a task complete without proving it works.
- Run `bun run typecheck` and `bun run build`; for behavior changes, boot the app
  (`bun run dev`) and verify (landing `200`, auth-guarded routes redirect, etc.).
- If verification can't run, explain why and state the remaining risk.
- End every completed task with a **"What's next for you"** section (deploy,
  `bun run db:generate` / migrations, manual checks, open decisions). Flag the most
  important action; if nothing is left, say so in one line.

### 6. Demand Elegance, Balanced
- Smallest correct change that fits the project style. Don't over-engineer.
- For non-trivial changes, ask "is there a more elegant way?" Challenge your own work.

### 7. Bug Reports Before Fixes
- For **ambiguous / recurring / production-impacting / out-of-scope** bugs, write
  `.agents/bugs/YYYY-MM-DD/<slug>.md` (summary, impact, env, repro, expected,
  actual, evidence, suspected cause, proposed fix) and confirm before editing.
- Fix small, obvious in-scope bugs directly and document them.

---

## Domain Rules

### UI & Design System

**Before any UI task (components, pages, styling, layout), read
`docs/design-system/` first** — it is the single source of truth.

- Use **tokens**, not literals (`bg-card`, `text-muted-foreground`, `ring-border`).
- Reuse primitives in `src/components/ui/` (shadcn `base-lyra` over Base UI) and the
  composite components (`AppShell`, `AppSidebar`, kanban, `ReviewDialog`).
- Two corner languages on purpose: primitives are sharp (`rounded-none`), app
  surfaces are soft (`rounded-xl`/`rounded-2xl`).
- Icons via **Hugeicons** (`<HugeiconsIcon icon={X} className="size-4" />`) — never
  `lucide-react`. Brand logos in `src/components/ui/svgs/`.
- Animation via **Motion** (`motion/react`) with `AnimatePresence`/`layout` for
  dynamic lists; the app is wrapped in `MotionConfig reducedMotion="user"`.
- Status/priority/tag colors come from the documented mappings (`tag-color.ts`,
  `COLUMN_META`, `PRIORITY_STYLE`). Tailwind needs **literal** class strings.
- If a task introduces a new reusable pattern or forces a deviation, **update the
  relevant `docs/design-system/` page in the same change.**

### TanStack Start / Server Functions

- Server functions use `createServerFn` from `@tanstack/react-start`; validate with
  **`.validator()`** (not `.inputValidator()`).
- Get the request/headers with `getRequest()` from `@tanstack/react-start/server`.
- The route tree (`src/routeTree.gen.ts`) is generated — never edit it by hand.
- Heavy route loaders must ship a `pendingComponent` + low `pendingMs` (see
  `docs/design-system/patterns/loading-skeletons.md`).
- Vite plugin order matters: **`cloudflare()` before `tanstackStart()`** in
  `vite.config.ts`; the worker entry is `@tanstack/react-start/server-entry`.

### Cloudflare / D1 / Drizzle

- Access bindings & secrets via `import { env } from "cloudflare:workers"` (never
  `process.env`). The D1 binding is `DB`.
- Drizzle schema lives in `src/lib/db/schema.ts`; the client in `src/lib/db/index.ts`.
- **Never create/edit/delete files under `drizzle/`** (generated migrations). Change
  the runtime schema only, then tell the user to run `bun run db:generate` and
  `bun run db:migrate:local|remote`.

### Auth (Better Auth)

- `getAuth()` (`src/lib/auth.ts`) is a lazy singleton built from `env` (D1 +
  secrets) — it can't be constructed at module top level.
- GitHub is the only provider; the access token is read via
  `auth.api.getAccessToken({ body: { providerId: "github" }, headers })`.
- Secrets live in `.dev.vars` (local) / `wrangler secret` (prod) — never commit them.

### GitHub data

- All GitHub calls run **server-side only** (`src/lib/github.ts`); the user's token
  must never reach the client.
- Board metadata is batch-fetched via the **GraphQL** blobs query (≈50 files/req);
  per-file REST fetch is only for on-demand single-file content (the dialog).
- The board reads `.agents/reviews/**` markdown; frontmatter + checkboxes drive card
  fields. Layout/column resolution (flat vs. date-folder, folder vs. frontmatter
  `status:` via `config.json`) lives in `lib/reviews-core.ts` (`resolveCardLocation`,
  `parseBoardConfig`) and is shared by both data sources; keep checklist parsing in
  `lib/review-stats.ts`. Non-`YYYY-MM-DD` dates go through `config.date.pattern`
  (`extractDate`); frontmatter keys not mapped to a card field land in
  `ReviewCard.custom` (`extractCustomFields`) and render in `review-dialog.tsx`'s
  `MetaPanel`.

---

## Gotchas

### 1. Starting edits without `.agents/todo.md`
**Prevention:** before any substantial edit, write a 3–5 step plan to `.agents/todo.md`.

### 2. Declaring test/build failures "pre-existing" without proof
**Prevention:** verify by running on the original code (e.g. `git stash`) before
claiming pre-existing; otherwise say it's unconfirmed.

### 3. Implementing full scope on a vague "ok"
**Prevention:** when moving from analyze → implement, confirm the exact scope and
work in reviewable chunks, pausing between them.

### 4. Editing files under `drizzle/`
**Prevention:** never touch generated migration files. Update the runtime schema and
call out the `bun run db:generate` + migrate follow-up.

### 5. Dynamic Tailwind class names don't get generated
**Mistake:** building classes like `` `bg-${color}-500` ``.
**Prevention:** Tailwind only emits classes it can statically see. Use full literal
class strings (see the `DOT`/`PILL` arrays in `src/lib/tag-color.ts`).

### 6. Importing Base UI primitives directly in feature code
**Prevention:** use the wrappers in `src/components/ui/` (e.g. `ui/popover.tsx`),
not `@base-ui/react/*`, so styling/behavior stays consistent. Only `ui/*` wraps the
primitive.

### 7. Showing a raw value/id instead of its label in a Base UI `Select`
**Prevention:** `<SelectValue>` renders the raw value by default — always map it to a
label (`<SelectValue>{(v) => OPTIONS.find(o => o.value === v)?.label ?? v}</SelectValue>`).

### 8. Using `lucide-react`
**Prevention:** the project standardized on Hugeicons. Import from
`@hugeicons/react` + `@hugeicons/core-free-icons`; verify the icon name exists.
