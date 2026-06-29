---
status: todo
assignees: ["fuongz"]
created_at: 2026-06-29 00:00:00Z
tags: []
---

# Review: Add drag and drop file .md

**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.

Today the board only supports dnd-kit card-dragging between columns (`kanban-board.tsx`) and an "Add task" dialog that creates an empty card (`create-card-dialog.tsx` → `createCard` → `createLocalReview`). This task adds the ability to drag a `.md` file from the OS (Finder/Explorer) onto the board to import it as a review card — a native browser file-drop, distinct from the existing in-app card drag.

## Decisions
- [ ] **D1. Intent.** "Drag and drop file .md" means dropping an external `.md` file from the desktop onto the board to **import it as a new review card** (not re-arranging cards, which already exists). Confirm this is the goal.
- [ ] **D2. Local-mode only.** Gate the whole feature behind `__LANEWORK_LOCAL__` like every other write path (`createCard`, `setCardStatus`, `saveCardContent`); the hosted board is read-only, so the drop zone is hidden/inert there.
- [ ] **D3. Drop target & UX.** Mount a board-level native drop zone (likely in `board.$owner.$repo.tsx`, around the `KanbanBoard`) that listens to native `dragover`/`drop` events and shows a "Drop .md to import" overlay — kept separate from the existing dnd-kit `DndContext` so the two drag systems don't conflict. Decide: import always into To-Do, or drop onto a specific column to set its status.
- [ ] **D4. File validation.** Accept only `.md` (and `.markdown`?); reject other types with a clear message; decide behavior for multiple files dropped at once (import each vs. first-only) and any size cap.
- [ ] **D5. Frontmatter handling.** Decide whether to preserve the dropped file's existing frontmatter verbatim, or normalize it (inject/default `status: todo`, `created_at`, `assignees`, `tags`) via `composeReviewFile`/`patchFrontmatter` so the card parses correctly. Files with no frontmatter must still land on the board.
- [ ] **D6. Filename & placement.** Decide where the file is written: reuse `createLocalReview`'s `.agents/reviews/<date>/NN-<slug>.md` naming (date-folder + ordinal, honoring folder vs. frontmatter board mode) vs. preserving the original filename — and how to resolve collisions.
- [ ] **D7. Title derivation.** Source the card title from the dropped file's `# Review:` heading, else its frontmatter, else the humanized filename.
- [ ] **D8. Server path.** Add a new server fn (e.g. `importCard`) + `local-fs` writer that takes raw markdown + filename, enforces the existing `.agents/reviews/` / no-`..` path guards (`safeFull`), and writes the file — deciding how much to reuse from `createLocalReview` vs. `saveLocalCardContent`.
- [ ] **D9. Post-import behavior.** After a successful import, `router.invalidate()` (live-reload also refreshes), surface/scroll to the new card, and decide whether to offer the optional "Investigate with an agent" step like the create dialog. Errors (invalid file, write failure, partial multi-file failure) surface via the existing alert/inline pattern.
