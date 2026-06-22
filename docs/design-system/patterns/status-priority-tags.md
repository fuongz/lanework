# Status, priority & tags

The canonical color mappings. Reuse these — don't invent new color logic per
component. Because some use literal palette colors (not tokens), **every literal
pairs a light value with a `dark:` variant.**

## Status (column) icon + color

Single source of truth: **`STATUS_META`** in `src/lib/review-status.ts` — used by the
board, column, list, dialog, and landing. Each status is a Hugeicon tinted with a
`text-*` color (rendered at `size-4`, or `size-3.5` inside pills).

| Status | Icon | Color |
| --- | --- | --- |
| To-Do | `DashedLineCircleIcon` | `text-amber-500` |
| In Progress | `Progress01Icon` | `text-blue-500` |
| Done | `CheckmarkCircle02Icon` | `text-emerald-500` |
| Dropped | `CancelCircleIcon` | `text-rose-500` |

```tsx
const m = STATUS_META[card.column];
<HugeiconsIcon icon={m.icon} className={cn("size-4", m.color)} /> {m.label}
```

In the dialog, status renders as a pill: `rounded-full bg-muted px-2.5 py-1 text-xs`
with the icon (`size-3.5`) + label.

## Priority

`high` / `medium` / `low` from frontmatter. Pill/badge classes:

```ts
high:   "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
low:    "bg-muted text-muted-foreground"
```

(See `PRIORITY_STYLE` in `kanban-card.tsx` and `review-dialog.tsx`.)

## Tags

Color is **deterministic per tag name** via `src/lib/tag-color.ts`. Class strings
are written out in full (no interpolation) so Tailwind's scanner keeps them.

- `tagColor(name)` → solid dot, e.g. `bg-blue-500` — for sidebar/list dots.
- `tagPill(name)` → soft filled pill, e.g.
  `bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300` — for tag chips.

10-color palette (rose, orange, amber, emerald, teal, sky, blue, violet, fuchsia,
pink) hashed by name → stable color across the app.

```tsx
<span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", tagPill(tag))}>{tag}</span>
<span className={cn("size-2 rounded-full", tagColor(tag))} />
```

> **Adding palette colors:** extend the `DOT` and `PILL` arrays in `tag-color.ts`
> with full literal class strings — never build class names by string
> interpolation, or Tailwind won't generate them.
