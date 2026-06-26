// Standardized, project-agnostic AGENTS.md template. Users drop this into their
// repo so their coding agent produces the `.agents/reviews/**` files this board
// visualizes. Project-specific Domain Rules / Gotchas go below the marked line.

export const AGENTS_TEMPLATE = `# Instructions for AI agents

These guidelines define how AI agents (Claude Code, Codex, Cursor, …) should work
on this repository. Follow them for code-related tasks while respecting the user's
latest explicit instructions.

**Conflict order:** the user's latest explicit request wins, then the most specific
local repository instruction, then these general rules.

## Where artifacts go

All agent working files live under \`.agents/\`. Use \`YYYY-MM-DD\` for every dated
filename so it sorts chronologically.

| Artifact | Path | When to write it |
| --- | --- | --- |
| Plan | \`.agents/todo.md\` | Before any substantial edit (3–5 concrete steps). |
| Review checklist | \`.agents/reviews/<status>/YYYY-MM-DD-<slug>.md\` | Behavior-changing work with real design decisions. |
| Lesson | \`.agents/lessons/YYYY-MM-DD/<slug>.md\` | After a durable correction likely to recur. |
| Bug report | \`.agents/bugs/YYYY-MM-DD/<slug>.md\` | Ambiguous / recurring / production-impacting bug. |

For **read-only requests** (review, translation, explanation), do not create, edit,
or delete these files unless the user explicitly authorizes it.

## Review gate

Before implementing behavior-changing work, write a review checklist to
\`.agents/reviews/<status>/YYYY-MM-DD-<slug>.md\` and wait for the user to check every
box. **Implementation starts ONLY after all items are \`[x]\`.**

Reviews are bucketed by **status** (the folder), not by date:

| status | meaning |
| --- | --- |
| \`todo\` | Plan written, boxes not all checked — awaiting review. New checklists start here. |
| \`processing\` | Approved (all gating boxes \`[x]\`) and being implemented. |
| \`done\` | Shipped and verified. |
| \`dropped\` | Superseded or abandoned. |

**Lifecycle:** create in \`todo/\` → move to \`processing/\` when approved → move to
\`done/\` once shipped (or \`dropped/\`). Moving a file is a plain rename — keep the
\`YYYY-MM-DD-<slug>.md\` name so it still sorts. The creation date never changes.

### Checklist frontmatter

Start each file with a YAML frontmatter block, then a \`# Review: …\` heading:

\`\`\`yaml
---
assignees: ["your-github-login"]
created_at: YYYY-MM-DD 00:00:00Z   # the filename date
priority: medium                   # low | medium | high
tags: ["area-a", "area-b"]         # your own controlled vocabulary
---
\`\`\`

Do **not** add a \`status:\` field — the folder encodes it. After the frontmatter,
add a "How to review" note (the user flips \`- [ ]\` to \`- [x]\` per item and writes
\`> notes\` under items they disagree with), group items by topic, include a Context
section, an explicit **out of scope** section, and a **files touched** table.
Mutually-exclusive options appear as separate "pick ONE" boxes with a recommendation.
If the user edits the checklist directly, treat their edits as decisions.

> The Kanban board reads exactly these signals: the **column** from the folder, and
> **date / priority / assignees / tags / progress** from the frontmatter + the
> \`- [ ]\` / \`- [x]\` checkboxes.

## Workflow

1. **Clarify & plan** — write \`.agents/todo.md\` (3–5 steps) before substantial edits; ask when ambiguous.
2. **Review gate** — for behavior-changing work with real design decisions (above).
3. **Subagents** — offload bounded research/exploration; keep the critical path in the main agent.
4. **Self-improvement** — record durable corrections in \`.agents/lessons/…\`.
5. **Verify before done** — never mark complete without proving it works; report changed files, verification result, and remaining risk; end with a "What's next for you" handoff.
6. **Demand elegance, balanced** — smallest correct change that fits the project style; don't over-engineer.
7. **Bug reports before fixes** — for ambiguous / recurring / production bugs, write \`.agents/bugs/…\` first and confirm before editing code.

## Gotchas

- Don't start edits without \`.agents/todo.md\`.
- Don't declare test failures "pre-existing" without proof (diff against the original).
- Don't implement full scope on a vague "ok" — confirm the exact scope first.
- Implement in reviewable chunks; pause for review between them.

---

<!-- Add your project-specific Domain Rules and Gotchas below this line. -->
`;

export const EXAMPLE_REVIEW = `---
assignees: ["your-github-login"]
created_at: 2026-06-21 00:00:00Z
priority: high
tags: ["auth", "api"]
---

# Review: Add rate limiting to the public API

**How to review:** flip \`- [ ]\` to \`- [x]\` for each item you agree with. Under any
item you disagree with, add a \`> ...\` note. I implement only after every box is \`[x]\`.

## Context (what exists)
- Current endpoints, no limits, token-based auth…

## Decisions
- [ ] **D1.** Limit to 100 requests/min per token (sliding window).
- [ ] **D2.** Respond with \`429\` + a \`Retry-After\` header when exceeded.

## Out of scope
- Per-route custom limits, billing-tier quotas.

## Files touched
| File | Change |
| --- | --- |
| \`src/...\` | … |
`;
