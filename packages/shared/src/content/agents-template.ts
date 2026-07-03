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
| Review checklist | \`.agents/reviews/YYYY-MM-DD/NN-<slug>.md\` | Behavior-changing work with real design decisions. |
| Lesson | \`.agents/lessons/YYYY-MM-DD/<slug>.md\` | After a durable correction likely to recur. |
| Bug report | \`.agents/bugs/YYYY-MM-DD/<slug>.md\` | Ambiguous / recurring / production-impacting bug. |

For **read-only requests** (review, translation, explanation), do not create, edit,
or delete these files unless the user explicitly authorizes it.

## Review gate

Before implementing behavior-changing work, write a review checklist to
\`.agents/reviews/YYYY-MM-DD/NN-<slug>.md\` and wait for the user to check every box.
**Implementation starts ONLY after all items are \`[x]\`.**

Each checklist has a **status** — its board column:

| status | meaning |
| --- | --- |
| \`todo\` | Plan written, boxes not all checked — awaiting review. New checklists start here. |
| \`processing\` | Approved (all gating boxes \`[x]\`) and being implemented. |
| \`done\` | Shipped and verified. |
| \`dropped\` | Superseded or abandoned. |

**Default layout — status in frontmatter, files grouped by date:**

\`\`\`
.agents/reviews/YYYY-MM-DD/NN-<slug>.md
\`\`\`

The date comes from the \`YYYY-MM-DD/\` folder; the leading \`NN-\` (\`01\`, \`02\`, …) orders
cards within that day; the **column is the \`status:\` field** in each file. Changing
status is a one-line edit — the file never moves.

### Checklist frontmatter

Start each file with a YAML frontmatter block, then a \`# Review: …\` heading:

\`\`\`yaml
---
status: todo                       # todo | processing | done | dropped
assignees: ["your-github-login"]
created_at: YYYY-MM-DD 00:00:00Z   # the date for this card
priority: medium                   # low | medium | high
tags: ["area-a", "area-b"]         # your own controlled vocabulary
---
\`\`\`

All fields are optional. Lists accept a JSON array (\`["a","b"]\`) or a comma-separated
string (\`a, b\`). \`priority\` must be \`low | medium | high\`; \`status\` one of the four
columns; anything else is normalised away. Keep \`created_at\` as \`YYYY-MM-DD\`. Fields the
board doesn't recognise are left untouched, so a repo can carry its own custom keys.

**Use your own key names.** To map existing frontmatter keys onto card fields, add a
\`fields\` block to \`.agents/reviews/config.json\` (the canonical key keeps working too):

\`\`\`json
{ "fields": { "assignees": ["owner"], "tags": ["labels"], "created_at": ["due"] } }
\`\`\`

**Alternative — status from the folder.** You can instead omit \`status:\` and place
files in \`todo/ processing/ done/ dropped/\` folders (either flat
\`<status>/YYYY-MM-DD-<slug>.md\` or \`<status>/YYYY-MM-DD/NN-<slug>.md\`); the folder
then sets the column. To make folders authoritative and ignore any \`status:\` field,
add \`.agents/reviews/config.json\` with \`{"status":{"from":"folder"}}\`.

**Client uses different status words?** The four columns (\`todo | processing | done |
dropped\`) are always the underlying model — advancing the lifecycle, the "ready to
advance" suggestions, etc. all key off them — but you can accept and display a client's
own vocabulary on top, in \`.agents/reviews/config.json\`:

\`\`\`json
{
  "status": {
    "values": { "processing": ["In Review", "WIP"], "done": ["Shipped"] },
    "labels": { "todo": "Backlog", "processing": "In Review", "done": "Shipped" }
  }
}
\`\`\`

\`values\` lets a file's \`status:\` field use any of those words in addition to the
canonical name (e.g. \`status: In Review\` resolves to \`processing\`). \`labels\`
overrides what the board displays for that column. Files lanework itself writes always
use the canonical value; the alias mapping only affects what's *read*.

After the frontmatter,
add a "How to review" note (the user flips \`- [ ]\` to \`- [x]\` per item and writes
\`> notes\` under items they disagree with), group items by topic, include a Context
section, an explicit **out of scope** section, and a **files touched** table.
If the user edits the checklist directly, treat their edits as decisions.

For **mutually-exclusive options**, nest the alternatives under a \`Pick one:\` bullet
and mark the default \`(Recommended)\`. Only the indented options are grouped, so keep
any conditional follow-up at the outer level — it stays an independent checkbox. The
board renders a nested group as radio buttons (selecting one clears the others):

\`\`\`md
- **D2. Storage backend — Pick one:**
  - [ ] **D2.A (Recommended)** In-memory sliding window (single region).
  - [ ] **D2.B** Durable Object counter (multi-region, more infra).
- [ ] **D3.** For D2.A: document the single-region limitation.  ← independent
\`\`\`

> The Kanban board reads exactly these signals: the **column** from the \`status:\`
> field (or the folder — see above), **date** from the \`YYYY-MM-DD/\` folder or filename,
> and **priority / assignees / tags / progress** from the frontmatter + the
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
status: todo
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
- [ ] **D1.** Respond with \`429\` + a \`Retry-After\` header when exceeded.
- **D2. Counter backend — Pick one:**
  - [ ] **D2.A (Recommended)** In-memory sliding window — single region, no new infra.
  - [ ] **D2.B** Durable Object counter — multi-region, more moving parts.
- [ ] **D3.** For D2.A: document the single-region limitation in the API docs.

## Out of scope
- Per-route custom limits, billing-tier quotas.

## Files touched
| File | Change |
| --- | --- |
| \`src/...\` | … |
`;
