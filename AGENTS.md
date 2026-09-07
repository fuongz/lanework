# Instructions for AI agents

This file tells AI coding agents (Claude Code, Codex, Cursor, …) how to record
their work so it shows up on a **lanework** board. lanework visualizes the
`.agents/reviews/` folder in this repo as a Kanban board — the review files you
write here are exactly what the board renders.

Follow these conventions for code-related tasks, while always respecting the
user's latest explicit instructions.

## Task-card creation — Lanework MCP only

When an agent creates a task/review card, it **must** call the configured
`lanework_mcp` tool `create_review` (or the MCP `handoff` flow for a successor
card). Never create or write a file under `.agents/reviews/` directly, and do not
use a raw filesystem writer as a fallback. If the Lanework MCP is unavailable,
report the blocker and ask the user to restore it; do not create the card by
another route.

## Where artifacts go

All agent working files live under `.agents/`. Use **`YYYY-MM-DD`** for every
dated filename (it sorts chronologically).

| Artifact | Path | When to write it |
| --- | --- | --- |
| Plan | **`save_plan` (Lanework MCP)** | Before any substantial edit (3–5 concrete steps). |
| Review checklist | `.agents/reviews/YYYY-MM-DD/NN-<slug>.md` | Behavior-changing work with real design decisions. |

⚠️ The plan is **not** a shared `.agents/todo.md`. One mutable file that every
session appends to loses a plan to last-writer-wins as soon as two agents run at
once; `save_plan` writes one plan per session and drops it when the session ends.

For **read-only requests** (review, explanation, translation), do not create,
edit, or delete these files unless the user explicitly authorizes it.

## Review gate for behavior-changing work

Before implementing behavior-changing work, write a review checklist to
`.agents/reviews/YYYY-MM-DD/NN-<slug>.md` and wait for the user to check every
box. **Implementation starts ONLY after all gating boxes are `[x]`.**

Each checklist has a **status** — its board column:

| `status` | Meaning |
| --- | --- |
| `todo` | Plan written, boxes not all checked — awaiting review. **New checklists start here.** |
| `processing` | Approved (all gating boxes `[x]`) and being implemented. |
| `done` | Shipped and verified. |
| `dropped` | Superseded or abandoned. |

Advancing a review is a one-line `status:` edit — the file never moves.

**Frontmatter** (the board reads these): start each file with YAML, then a
`# Review: …` heading:

```yaml
---
status: todo                       # todo | processing | done | dropped
agent_assignee: ["code-reviewer"]   # the card's agent PIC — one agent, start to finish
created_at: YYYY-MM-DD 00:00:00Z   # the date for this card
priority: medium                   # low | medium | high
tags: ["ui", "server-fn"]          # AT MOST 3, from a short vocabulary for your repo
---
```

After the frontmatter, add a short "How to review" note (flip `- [ ]` → `- [x]`,
write `> notes` under any disagreement), group checklist items by topic, and
include Context, an explicit **out of scope** section, and a **files touched**
table. Make mutually-exclusive options separate "pick ONE" boxes with a
recommendation. Treat direct user edits to the checklist as decisions.

What does **not** need a review: read-only requests, single-file obvious fixes,
or tasks where the user specified the exact shape. Those only need a
`save_plan` call.

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
- If verification can't run, explain why and state the remaining risk.
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
