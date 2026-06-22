# Loading & skeletons

Never block the screen on a slow loader. Show a skeleton that mirrors the final
layout so the transition is calm and there's no layout shift.

## Route pending states (TanStack Router)

The board loader is heavy (git tree + batched GraphQL content fetch + viewer). The
board route shows a skeleton almost immediately:

```ts
// src/routes/board.$owner.$repo.tsx
pendingComponent: PendingBoard,
pendingMs: 120,      // show the skeleton after 120ms of loading
pendingMinMs: 400,   // keep it at least 400ms to avoid a flash
```

`PendingBoard` reads `Route.useParams()` and renders `BoardSkeleton` with the
owner/repo so the user sees *which* board is loading.

## Skeleton recipe

Compose `ui/skeleton.tsx` (`animate-pulse bg-muted`) in the shape of the real UI.
`BoardSkeleton` (`src/components/kanban/board-skeleton.tsx`) mirrors AppShell:
sidebar blocks + a header (real owner/repo text) + four lanes of card skeletons.

Guidelines:

- Match real **dimensions** (`w-64` sidebar, `w-80` lanes, card padding) so swapping
  to real content doesn't shift layout.
- Skeleton **structure**, not every pixel — a few representative lines per card.
- Show real, already-known text (the repo name from params) rather than a bar.

## In-component loading

For content fetched after mount (e.g. the review markdown in `ReviewDialog`),
render skeleton lines in place until the data resolves, then swap to the article.
