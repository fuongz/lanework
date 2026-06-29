# TODO — Local agent dispatch + DnD + Running column (Phase 1)

Review: `.agents/reviews/2026-06-29/01-local-agent-dispatch.md`

1. **Column model** — add `running` to `REVIEW_COLUMNS` (reviews-core.ts) and fill
   the four typed `Record<ReviewColumn>` literals it forces: `STATUS_META`
   (review-status.ts), `kanban-board.tsx` byColumn, `review-list.tsx` (HEADER_TINT,
   DOT, `by`), and the MCP `COLUMNS` array (mcp.mjs). Order: todo → running →
   processing → done → dropped.
2. **`setCardStatus` server fn** — local-only POST in `server/reviews.ts` wrapping
   `setLocalReviewStatus` (mirror `saveCardContent`).
3. **Drag-and-drop** — `@dnd-kit/core` in `kanban-board.tsx` (add dep to root +
   apps/local). Column-to-column moves; click-vs-drag via pointer activation
   distance. Local-only; hosted renders as today. Drop on a column → `setCardStatus`;
   drop on **Running** → dispatch.
4. **Dispatcher** — `apps/local/agent-runner.mjs` (registry + run/stop/status) wired
   into `server.mjs` as `POST /_local/agent/run|stop` + `GET /_local/agent/status`.
   Worktree per card, `claude -p` headless with lanework MCP pointed at the main
   checkout. `.lanework/` in `.gitignore`.
5. **Verify** — `bun run --cwd apps/local build` + `bun run typecheck`; manual
   round-trip (drag into Running → agent works → ticks items → Done).
