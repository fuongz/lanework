---
status: done
assignees: []
created_at: 2026-06-29 00:00:00Z
priority: high
tags: ["local", "agents", "orchestration"]
---

# Review: Dispatch parallel Claude Code agents from cards (local CLI)

Turn the local board from a passive *visualizer* of `.agents/reviews/` into an
active *orchestrator* — a "Run agent" action on a card spawns a headless Claude
Code agent in its own git worktree, which reports progress back onto the card
through the MCP tools we already ship. Multiple cards run in parallel. This is the
Notion-Kanban-as-control-plane pattern (the "Cursor Investigator is working"
screenshot), scoped to **local only** (`apps/local`).

**Why local-only:** the hosted Cloudflare Worker can't spawn processes or create
git worktrees, and is deliberately read-only. `apps/local/server.mjs` is a
long-lived Node process with filesystem access and an existing file-watch SSE — it
is the natural and only home for a dispatcher.

**Key insight:** we already have the hard half. The MCP server
(`set_status`, `toggle_item`, `update_review`) is how an agent reports back, and
the live-watch SSE (`/_local/events`) already re-renders cards on file change. The
only missing piece is the **dispatcher** that launches an agent per card.

**How to review:** flip `- [ ]` to `- [x]` for each decision you agree with; add a
`> note` under any you don't. Implementation starts only after every box is `[x]`.

## Architecture decisions

- [x] **D1. Dispatcher lives in `server.mjs`.** Add Node HTTP routes alongside the
  existing `/_local/events`: `POST /_local/agent/run` (body `{ path }`), `POST
  /_local/agent/stop` (`{ path }`), and `GET /_local/agent/status` (SSE or JSON).
  No new server, no Worker changes.

- [x] **D2. One git worktree per card (isolation).** On run:
  `git worktree add <root>/.lanework/worktrees/<slug> -b lanework/<slug>` (branch
  off current HEAD). The agent's `cwd` is the worktree, so parallel agents never
  collide on files. Remove the worktree on a clean, merged finish; keep it on
  failure for inspection. Add `.lanework/` to `.gitignore`.

- [x] **D3. Control plane stays in the main checkout.** The spawned agent's
  *code edits* happen in the worktree, but its lanework MCP server is launched with
  `LANEWORK_DIR = <main checkout>` so `toggle_item` / `set_status` write to the
  `.agents/reviews/` the user is actually watching. Clean split: work in the
  worktree, status on the board.

- [x] **D4. Backend: Claude Code headless.** Spawn
  `claude -p "<prompt>" --permission-mode acceptEdits` (exact flags TBD in impl)
  with cwd = worktree and the lanework MCP server attached via `--mcp-config`. Keep
  the spawn command in one small module so a future backend-agnostic mode (Cursor
  CLI / Codex) is a drop-in.

- [x] **D5. The prompt.** Built from the card's own markdown: "Here is a review
  card. Implement its decisions in this directory (a git worktree). As you complete
  each checklist item, tick it with the lanework `toggle_item` tool; when done, call
  `set_status` → done. Do not edit `.agents/`." Card content read via
  `getLocalCardContent`.

- [x] **D6. "Is working" status round-trip.** On dispatch, immediately
  `set_status` → `processing` and stamp a frontmatter marker (e.g.
  `agent: claude` + `agent_started_at`). The board shows the card as in-progress
  live via the existing watcher — no polling needed for the basic indicator. On
  exit 0 leave as the agent left it; on non-zero, add a `> note` and a visible
  failure marker (do not silently revert).

- [x] **D7. In-memory process registry.** `server.mjs` keeps a `Map<cardPath, {
  pid, worktree, branch, startedAt, state }>`. `GET /_local/agent/status` streams
  it so the UI can show a live spinner + a tail of the agent's stderr per running
  card (Phase 2 nicety). Single long-lived process → in-memory is sufficient; no DB.

- [x] **D8. UI affordance.** A "Run agent" button on the card / review dialog
  (gated to local mode — guard on `__LANEWORK_LOCAL__`), and a per-card running
  indicator ("Claude is working ›") that mirrors the screenshot. Reuse existing
  kanban card + dialog components and design tokens (`docs/design-system/`).

- [x] **D9. Safety rails.** Concurrency cap (default e.g. 4 parallel agents,
  configurable); refuse to run if the worktree branch already exists; a hard
  timeout per agent; `stop` kills the process group and optionally prunes the
  worktree. Surface what was capped/skipped — never silent.

## Drag-and-drop + "Running" column (added)

- [x] **D10. Drag-and-drop to move cards between columns (local-only).** A
  cross-column drag persists the card's new column via a **new local-only
  `setCardStatus` server function** that calls the existing
  `setLocalReviewStatus` (frontmatter `status:` rewrite). Within-column order stays
  date/ordinal-sorted — no manual reordering needed. Gated to local mode like
  `saveCardContent` (hosted is read-only → cards not draggable there).

- [x] **D11. DnD library: `@dnd-kit/core`** (chosen) — small, accessible, touch +
  keyboard, clean drag overlay; we only need column-to-column moves.

- [x] **D12. New `running` column.** Extend the single source of truth
  `REVIEW_COLUMNS` in `reviews-core.ts:8` with `running`, plus its two satellites:
  `STATUS_META` (label "Running" + spinner icon + distinct color) and the MCP
  `COLUMNS` array in `mcp.mjs`, and the `byColumn` init in `kanban-board.tsx`.
  Column order: **todo → running → processing → done → dropped**. `running` =
  "an agent is actively working" — the lane from the screenshot. `processing`
  stays the **manual / human-in-progress** lane, untouched by the agent path.

- [x] **D13. Drag into Running = dispatch (the Notion mechanic).** Dropping a card
  onto the Running column calls `POST /_local/agent/run` (which sets status →
  `running`, creates the worktree, spawns the agent) — this becomes the **primary
  trigger**, with the D8 "Run agent" button kept as an explicit alternative.
  Dragging a card OUT of Running (or onto Dropped) calls `/_local/agent/stop`
  (kill + prune). Agent path: drag→running → ticks items via `toggle_item` →
  on success `set_status` → `done`; on failure, a `> note` + stays in `running`
  with a failure marker. On server start, reconcile stale `running` cards (in
  `running` with no live process) — mark them, don't silently strand them.

- [x] **D14. Backward moves + graceful re-run.** Done is not terminal: dragging a
  card from `done` → `todo`/`processing` is a plain status "reopen" (works via
  `setCardStatus`). Dragging `done` → `running` re-dispatches an agent — and if the
  card's previous finished branch still exists (unmerged implement run), the re-run
  allocates a **fresh suffixed branch/worktree** (`lanework/<slug>-2`, …) instead of
  erroring, so the prior attempt's work is never silently destroyed. A still-*running*
  agent still can't be double-dispatched.

- [x] **D15. Lock running cards (no drag).** A card in the `running` lane is
  **not draggable** — a stray drag must never silently kill a working agent and prune
  its worktree. Interrupting is intentional only: the **Stop** button in the card
  dialog (which kills + cleans + moves it to To-Do). Click-to-open still works, and a
  hover title explains why it's locked. (Replaces the prior drag-out-stops behavior.)

## Scope

- [x] **S1. Phase 1 (this card): one-card PoC + DnD + Running column.** Add the
  `running` column and `setCardStatus`; wire drag-and-drop; dragging a card into
  Running spawns one `claude -p` agent in a worktree; it ticks items via MCP and
  advances to `done`; board updates live. Prove the round-trip end to end.

- [x] **S2. Phase 2 (follow-up card): parallel + live logs.** Multi-card dispatch,
  concurrency cap, per-card stderr tail in the UI, stop/cleanup controls.

- [x] **S3. Out of scope for now:** auto-opening PRs, non-Claude backends, hosted
  app — tracked as later cards.

## Verification

- [x] **V1.** `bun run --cwd apps/local build` and `bun run typecheck` pass.
- [x] **V2.** Manually: create a tiny review card, click Run, watch it flip to
  processing, see items tick themselves, confirm code landed on the worktree branch
  and `.agents/reviews/` was updated in the main checkout (not the worktree).
- [x] **V3.** Killing the agent (`stop`) terminates the process and leaves the
  board in a sane state.
- [x] **V4.** Drag a card across columns → frontmatter `status:` updates on disk
  and the card stays put after a refresh (persisted, not just visual).
- [x] **V5.** Drag a card into Running → an agent spawns, the card shows "working"
  live, items tick themselves, and it lands in Done. Drag out → agent stops.
