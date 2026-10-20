// The project order's arithmetic, shared by the project switcher's reorder
// list (`project-reorder-list.tsx`).

/** `slugs` with `slug` moved to where `over` is (FE-32). */
export function moveSlug(
  slugs: string[],
  slug: string,
  over: string,
): string[] {
  const from = slugs.indexOf(slug);
  const to = slugs.indexOf(over);
  if (from < 0 || to < 0 || from === to) return slugs;
  const next = [...slugs];
  next.splice(from, 1);
  next.splice(to, 0, slug);
  return next;
}

/**
 * How far row `index` steps aside while the row at `from` hovers over `to`:
 * one lifted row's height, toward the gap it leaves (FE-32).
 */
export function shiftFor(
  index: number,
  drag: { from: number; to: number; height: number } | null,
): number {
  if (!drag || index === drag.from) return 0;
  if (drag.from < drag.to && index > drag.from && index <= drag.to)
    return -drag.height;
  if (drag.to < drag.from && index >= drag.to && index < drag.from)
    return drag.height;
  return 0;
}
