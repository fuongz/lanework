# Instructions for AI agents

This file holds what is particular to this repo. How to use the Lanework
board comes with the `lanework` MCP server's instructions, not from here.

Follow these conventions for code-related tasks, while always respecting the
user's latest explicit instructions. Desktop rules are indexed in
[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) (DOC-01).

## Lanework board

Cards for this repo live on Lanework, through the `lanework` MCP server.
Follow its instructions for finding the board, writing cards and working
them. If the server is not connected, say so and stop rather than tracking
the work another way (never as a local file).

What only this repo adds:

- **Categories:** `product-design`, `frontend`, `backend`, `infrastructure`,
  `documentation`. Classify cross-repo work by the target repo.
- **Lanes:** `todo` → `processing` → `review` → `done` (or `dropped`); see
  [lanes](docs/agents/lanes.md). Streams: [docs/agents/streams.md](docs/agents/streams.md).
- **Resuming:** `nextStep` may come from an older checkpoint than the newest
  (`nextStepFrom` says which): the Stop hook writes after every turn but never
  states a next step. Tick boxes only for what YOU verified.
- **Checkpoint hook:** Claude Code and Codex checkpoint after every turn
  through the Stop hook the app installs (**Settings → Agents**) or the Claude
  Code plugin, which lives in [lanework-dev/plugins](https://github.com/lanework-dev/plugins)
  and bundles `apps/desktop/electron/hook/`. After changing the hook or
  anything it imports, commit here, then `bun run build:plugin` writes the
  bundle into a clone of that repo (`--out`, `LANEWORK_PLUGINS_DIR`, or
  `../lanework-dev/plugins`) for a commit there. This repo carries no copy of
  the hook. Details: [docs/agents/checkpoint-hook.md](docs/agents/checkpoint-hook.md).
- `.agents/reviews/` is gone (BE-09): cards used to be files there; do not
  recreate the folder.

## Two boards since the repo split (2026-10-14)

| Repo | Board |
| --- | --- |
| `github.com/fuongz/lanework` (this repo: desktop, plugin) | **fuongz/lanework-public** |
| `github.com/fuongz/lanework-cloud` (API, MCP, landing, db) | **fuongz/lanework** |
| `github.com/lanework-dev/contracts` (`@lanework/contracts`) | **lanework.dev/contracts** |

Commits and comments written before these moves use **old** ids, and so
does this file. When an id's card does not match, look it up in
[docs/agents/id-history.md](docs/agents/id-history.md).

## Where artifacts go

Agent working files (test results, scratch output) live under `.agents/`. Use
**`YYYY-MM-DD`** for every dated filename (it sorts chronologically). Only
`release-notes/` (`YYYY-MM-DD-vX.Y.Z.md`, Keep a Changelog from v0.10.0)
and the comment-style check are committed; everything else, such as
`scratch/`, `artifacts/` and `research/`, is git-ignored. The plan
lives in the agent's own session plan/todo tool, **not** a shared
`.agents/todo.md`: one mutable file every session appends to loses a plan to
last-writer-wins as soon as two agents run at once. For **read-only requests**
(review, explanation, translation), do not create or change cards or files
unless the user explicitly authorizes it.

## Code search (FE-152)

With the desktop app, `lanework-kit` (MCP) and `lwk` find files, code shapes
and past chats fast: [docs/agents/lanework-kit.md](docs/agents/lanework-kit.md).

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

## Version names (INF-10)

Release `X.Y.Z` lives in `apps/desktop/package.json` and only
`mise run release:bump <patch|minor|major>` changes it. `app:package` and
`app:install` stamp `X.Y.Z-preview-YYYYMMDDHHmm` into the bundle and never
write package.json. Details: [docs/releasing.md](docs/releasing.md).

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
