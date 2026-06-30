# Kanban

The board is the core surface. Files map 1:1 to UI: `.agents/reviews/<status>/…md`
→ columns; frontmatter + checkboxes → card fields.

## Columns

Four fixed statuses, defined once in **`STATUS_META`** (`src/lib/review-status.ts`)
as label + icon + color — see [status, priority & tags](./status-priority-tags.md):
To-Do (`DashedLineCircleIcon`, amber), In Progress (`Progress01Icon`, blue), Done
(`CheckmarkCircle02Icon`, emerald), Dropped (`CancelCircleIcon`, rose).

Lane recipe: `flex h-full w-80 shrink-0 flex-col rounded-2xl bg-muted/40`, header
= `<status icon> <label> <count>`, scrollable body `gap-2.5 px-2.5 pb-2.5`.

## Card recipe

`KanbanCard` — soft card, clickable (opens `ReviewDialog`):

```
rounded-xl border bg-card p-3.5 shadow-xs  (hover: shadow-md; lift via Motion wrapper)
├── title            line-clamp-2 text-sm font-medium
├── assignees row    "Assignees:" + overlapping avatars (github.com/<login>.png), +N
├── meta row         <Flag02Icon> <date>   + PriorityBadge (ml-auto)
└── footer (border-t) <Check> done/total · <Comment> notes · progress% pill (ml-auto)
```

- **Date**: `formatDate(card.date)` (`src/lib/format.ts`).
- **Progress %**: `progressPercent(card.stats)` (`src/lib/review-stats.ts`); pill
  is emerald at 100%, muted at 0%, amber in between.
- Colors for priority/tags: [status, priority & tags](./status-priority-tags.md).

## Running an agent (local)

Local mode only (`__LANEWORK_LOCAL__`). On card hover a **Run** button
(`RunAgentButton`, `PlayIcon`, in `kanban/run-agent-button.tsx`) dispatches a
Claude Code agent against that review; it stops pointer/click propagation so it
never triggers the card's drag or open. While one is running the card shows an
`AgentWorkingBadge` — a violet, pulsing "Claude is working" indicator
(`RoboticIcon` + ping dot). The review dialog has a fuller `AgentPanel` with
**Run agent / Stop / Merge** (`PlayIcon` · `StopIcon` · `GitMergeIcon`).

## Checklist progress (in the review)

Each checklist in `ReviewDialog` carries its own header count, scoped to that
list's items. `CircleProgress` (a `currentColor` SVG ring, faded track) fills as
boxes are ticked and is replaced by a solid `CheckmarkCircle02Icon` at 100%, next
to an `x of x` count. Counts are live without re-running the Shiki pipeline: rows
write their state into a stable, line-keyed store and the header subscribes via
`useSyncExternalStore`. "Pick one" radio groups collapse to a single item.

## List view

`ReviewList` — the "List" tab. Rows grouped by status; each row: title · date ·
`done/total` · `%`. Same data, denser presentation.

## Filtering

Filtering is **client-side** by URL search params on the board route
(`?mine=true`, `?tag=…`); the loader is not re-run. Removed/added cards animate
via `AnimatePresence` (see [animation](../animation.md)). The header title and the
`filtered / total` count reflect the active filter.
