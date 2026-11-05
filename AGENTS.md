# Instructions for AI agents

This file tells AI coding agents (Claude Code, Codex, Cursor, …) how to record
their work so it shows up on this repo's **lanework** board. The board lives in
the cloud and is reached ONLY through the remote Lanework MCP server
(`https://mcp.lanework.dev/v1`) — there are no card files in this repo.

Follow these conventions for code-related tasks, while always respecting the
user's latest explicit instructions. Desktop rules are indexed in
[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) (DOC-01).

## Finding the board

Every tool takes a `board_id`. Run `git remote get-url origin` and call
`list_boards({ repo })` with the output as is: exactly one board → use it; none
or several → ask the user (and `link_repo` once they answer). Never pick a board
by its name.

## Task-card creation — Lanework MCP only

When an agent creates a task/review card, it **must** call the Lanework MCP tool
`create_review` (pass `parent_id` for a successor card). If the Lanework MCP is
unavailable, report the blocker and ask the user to restore it; do not create
the card by another route — in particular, never write a card as a local file.

## `.agents/reviews/` is gone (BE-09)

Cards used to be files under `.agents/reviews/`; all were imported to the
cloud. Do not recreate the folder.

## Two boards since the repo split (2026-10-14)

| Repo | Board |
| --- | --- |
| `github.com/fuongz/lanework` (this repo: desktop, protocol, plugin) | **fuongz/lanework-public** |
| `github.com/fuongz/lanework-cloud` (API, MCP, landing, db) | **fuongz/lanework** |

Commits and comments written before these two moves use **old** ids, and so
does this file. When an id's card does not match, look it up in
[docs/agents/id-history.md](docs/agents/id-history.md).

## Required card metadata

Every new task/review card **must explicitly include `category`, `tags`, and
`priority`** in the `create_review` call. Do not omit them, leave them empty,
or rely on server defaults. This also applies to successor cards.

- **Category:** choose the main implementation area: `product-design`,
  `frontend`, `backend`, `infrastructure`, or `documentation`. The agent is
  authorized to choose based on the task; follow an explicit user choice when
  given. For cross-repo cards, classify the work in the target repo.
- **Tags:** use 1–3 relevant tags. Read `board_summary` (or `list_reviews`)
  first and reuse the board's vocabulary; add a short tag only when no existing
  tag fits.
- **Priority:** choose `high` for blockers, critical fixes, or prerequisites
  for the agreed release; `medium` for normal planned work; `low` for optional
  polish. Always pass the value explicitly.

After creating or updating a card, verify through `get_review` or
`list_reviews` that all three fields are populated and valid, and that the MCP
assigned a task ID. Correct omissions with `update_review` before handing off.
Never invent a task id yourself; the MCP assigns it from the category.
Use `update_review` for metadata, `toggle_item` for checklist boxes and notes,
and `set_status` for lifecycle changes. Metadata changes do not approve
checklist items or change the card's status.

## Checkpoints and resuming a card (BE-17)

Any agent may have to hand a card to another one mid-task — Claude out of
quota, work moving from a laptop to the cloud. The baton lives on the card, in
the cloud, never in a local file.

- **Leave a checkpoint.** While working a card, call the MCP tool `checkpoint`
  after each checklist item you finish and before you stop mid-task: what is
  done, what is verified and how, the next step, the files you changed. Never
  paste transcripts, secrets, tokens or `.env` values. A card keeps its last 5
  checkpoints; moving it to done or archiving it clears them.
- **Claude Code and Codex do this by themselves** after every turn, through
  the Stop hook the desktop app installs (**Settings → Agents**, FE-28,
  FE-29) or the **plugin** (INF-03, `plugins/lanework/`). Its bundle,
  `plugins/lanework/bin/lanework-checkpoint.cjs`, is committed — rebuild it
  with `bun run build:plugin` after changing the hook; `bun run gate` fails
  when it is stale. This repo carries no copy of the hook (two installs
  would checkpoint twice). Details:
  [docs/agents/checkpoint-hook.md](docs/agents/checkpoint-hook.md).
- **Resume ("resume BE-17").** `get_review` the card and read `checkpoint`.
  If `checkpoint.git.wipRef` is set and you are NOT in the checkout it came
  from (`checkpoint.host` is another machine, a fresh clone, a cloud sandbox),
  start from `checkpoint.git.head`, then
  `git fetch origin <wipRef> && git cherry-pick --no-commit FETCH_HEAD && git reset`.
  In the same checkout the work is already on disk — skip that step, or it
  conflicts with itself. `nextStep` may come from an older checkpoint than the
  newest (`nextStepFrom` says which): the Stop hook writes after every turn
  but never states a next step. Re-run every check the checkpoint claims
  passed before trusting it, then continue from `nextStep` (or the summary).
  Tick checklist boxes only for what YOU verified.

## Where artifacts go

Agent working files (test results, scratch output) live under `.agents/`. Use
**`YYYY-MM-DD`** for every dated filename (it sorts chronologically).

| Artifact | Where | When |
| --- | --- | --- |
| Plan | The agent's own session plan/todo tool | Before any substantial edit (3–5 concrete steps). |
| Review checklist | A card via `create_review` | Behavior-changing work with real design decisions. |

⚠️ The plan is **not** a shared `.agents/todo.md`. One mutable file that every
session appends to loses a plan to last-writer-wins as soon as two agents run at
once.

For **read-only requests** (review, explanation, translation), do not create or
change cards or files unless the user explicitly authorizes it.

## Review gate for behavior-changing work

Before implementing behavior-changing work, open a review card with
`create_review` and wait for the user to tick every gating box. **Implementation
starts ONLY after all gating boxes are ticked.**

Each card has a **status** — its board lane:

| `status` | Meaning |
| --- | --- |
| `todo` | Plan written, boxes not all ticked. **New cards start here.** |
| `processing` | All gating boxes ticked; being built. |
| `review` | Built, verified; a human reviews. |
| `done` | Shipped and verified. |
| `dropped` | Superseded or abandoned. |

Advance it with `set_status` ([lanes](docs/agents/lanes.md)).

The card is a `body` (markdown) plus a `checklist`. Put Context, an explicit
**out of scope** section and a **files touched** table in the body. Checklist
items go in `decisions` (what the user approves) or `verify` (how you will prove
it). Give mutually-exclusive options the same `group` so they read as "pick
ONE", and mark the recommendation. Treat the user's own ticks and notes on the
card as decisions.

What does **not** need a review: read-only requests, single-file obvious fixes,
or tasks where the user specified the exact shape. Those only need a
plan.

## Streams: one card, several sub-agents (BE-19)

A card may carry **streams** (`W0`, `W1`, …) — each one sub-agent's job, so
Claude Code or Codex can run independent parts of a card in parallel.

**When writing a card**, split it into streams when it touches **two or more
independent write areas** (e.g. db + mcp + desktop). Small cards (1–2 files)
have none. Each stream needs:

- `key`, `title`, `goal`, `role` (`research`, `implement` or `test`);
- `owns` — exact paths, or directories ending in `/`; no globs. Two streams
  never own the same path;
- `reads`, `depends_on` (stream keys), `isolation` — `worktree` (the default)
  or `shared` for read-only research;
- at least one `verify` item tagged `stream: "<key>"`. Untagged verify items
  belong to the lead: gate, build, e2e, real-app checks.

Shared files (types, schema, contracts) go in a **`W0`** stream the others
depend on. **At most 4 streams per wave.** Keep the human **files touched**
table; `owns` is its machine-readable per-stream form.

**Running a card with streams.** `get_review` returns `streams` and
`dispatch: { waves, briefs }`; the agent that got the card is the **lead**:

1. For each wave, spawn every stream of the wave in **one** turn (Claude Code:
   several `Agent` calls in one message; Codex: its sub-agents), each in its own
   git worktree from the current HEAD unless the stream is `shared`. Hand each
   sub-agent `dispatch.briefs[key]` verbatim. No sub-agents? Run the streams
   one by one in wave order.
2. Sub-agents write only inside `owns`, may build and test in their own
   worktree, and report the files they changed and the checks they ran. They
   **never** call the Lanework MCP and never commit.
3. After the wave, the lead merges each worktree into the main checkout (3-way
   per file against the base), reverts anything outside `owns`, re-runs the
   stream's checks, ticks that stream's verify items, and calls `checkpoint`
   **once** for the wave.
4. After the last wave, the lead runs the untagged verify items.

Only the lead writes to the card. On **resume** (BE-17), re-dispatch only the
streams whose verify items are not all ticked. A card without streams works
as before: one agent, end to end.

## Reusable scripts

Before writing a one-off script for a mechanical task (CSV/JSON conversion,
a data reshape, a repetitive transform), check `.claude/tools/` — each
subfolder is a small script someone already wrote for exactly this kind of
job. Its `TOOL.md` frontmatter names the `runtime` and `entrypoint` to run,
e.g. `python3 main.py <args>`. Prefer running one of these over writing new
code from scratch; add a new one there yourself if the task is likely to
recur.

## Verification before done

- Never mark a task complete without proving it works. Run the project's
  typecheck/build; for behavior changes, boot the app and verify.
- **Do not run tests unless the user asks — however large the task.** Not the
  suite, not a spec file, not a single `-g` case, and not on "commit" either:
  tests run only when the user says to run them (or they run them by hand).
  Build and typecheck are cheap and stay.
- When asked to run tests, run only what was asked — e.g. `playwright test
  tests/<file>.spec.ts -g "<name>" --project=production` for one case.
- **`bun run build` before any Playwright run**, including a single `-g` case.
  The specs boot `dist/` and `playwright.config.ts` has no build step, so a run
  started without building tests the previous bundle and reports green for code
  that was never exercised.
- If verification can't run — or was deliberately not run under the rule above —
  **say so plainly** rather than implying it passed, and state the remaining risk.
- End every completed task with a **"What's next for you"** handoff (follow-up
  commands, manual checks, open decisions).

## Git commits

- After completing and verifying a code task, create a local commit for the
  task's changes unless the user explicitly asks not to commit. No reminder or
  extra confirmation is needed. Do not push unless the user requests it.
- Use **Conventional Commits**: `<type>(<scope>): <short imperative summary>`.
  Examples: `feat(desktop): initialize Electron app`,
  `fix(ipc): reject untrusted senders`, `docs(agents): document commit rules`.
- Choose the type that describes the change (`feat`, `fix`, `refactor`, `docs`,
  `test`, `build`, `ci`, `chore`, `perf`, or `style`). Use a meaningful scope;
  mark breaking changes with `!` and explain them in the body.
- Review the staged diff before committing. Stage only task-related files;
  preserve unrelated user changes. Never commit secrets, dependencies, generated
  builds, installers, or temporary verification artifacts.
- Prefer one coherent commit per logical change. Report the commit hash and
  verification results in the final handoff. Never amend or rewrite existing
  commits unless explicitly requested.
