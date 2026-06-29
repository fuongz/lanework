---
status: todo
assignees: ["fuongz"]
created_at: 2026-06-29 00:00:00Z
tags: []
---

# Review: Manual update tag on task

**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.

Today tags on a card are **read-only** in the UI — the `ReviewDialog` MetaPanel renders tag pills (`packages/shared/src/components/kanban/review-dialog.tsx:812`) with no edit affordance. The write plumbing already exists at the bottom layers (`updateLocalReviewMeta` in `local-fs.ts:277`, the `update_review` MCP tool in `apps/local/mcp.mjs:262`), but no `createServerFn` exposes tag edits to the frontend. This task wires up a manual tag editor end to end.

## Decisions
- [ ] **D1. Where the editor lives.** Add inline tag editing to the `ReviewDialog` MetaPanel "Tags" row only (mirroring the existing read-only pills), rather than also adding it on the board card face or the sidebar — keep one edit surface.
- [ ] **D2. New server function.** Add a `setCardTags` (or `updateCardMeta`) `createServerFn` in `packages/shared/src/server/reviews.ts` that wraps `updateLocalReviewMeta(path, { tags })`, following the exact pattern of `setCardStatus`/`saveCardContent` (path validator restricting to `.agents/reviews/**.md`, `__LANEWORK_LOCAL__`-only, throw in cloud mode).
- [ ] **D3. Local-mode gating.** Gate the tag editor behind `__LANEWORK_LOCAL__` like the Save/Delete/Agent panels; the cloud build stays read-only (renders pills, no edit).
- [ ] **D4. Persist via frontmatter patch, not full rewrite.** Use `updateLocalReviewMeta` → `patchFrontmatter` so only the `tags:` line changes and the body/checkbox state is never clobbered (don't route through `saveCardContent`/`applyTaskStates`).
- [ ] **D5. Input UX.** Choose the affordance: editable chips with add/remove + free-text entry, vs. a `Command` combobox that suggests existing repo tags. If suggesting, reuse the sidebar's aggregated tag list (the same data feeding `TagMore`) so users converge on existing tags.
- [ ] **D6. Normalization rules.** Decide trim / lowercase / dedupe / max-count / allowed-charset for tag values, since `parseList` (`reviews-core.ts:302`) currently does none. Put the rule in a shared helper so the UI, the new server fn, and the `update_review` MCP tool all agree.
- [ ] **D7. Refresh after save.** After a successful save, `router.invalidate()` so the card pills, board, and sidebar tag counts/filters reflect the change; decide whether to also update `board-store` optimistically vs. await-and-reload.
- [ ] **D8. Edge cases & errors.** Confirm removing all tags writes `tags: []`, and surface save failures in the dialog using the existing `saveError` pattern.
