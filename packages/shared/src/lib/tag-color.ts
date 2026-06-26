// Deterministic color per tag name. Class strings are written out in full
// (no interpolation) so Tailwind's scanner picks them up.

const DOT = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-pink-500",
];

const PILL = [
  "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-950/60 dark:text-pink-300",
];

function indexOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % DOT.length;
}

/** Solid dot color (sidebar / lists). */
export function tagColor(name: string): string {
  return DOT[indexOf(name)];
}

/** Soft filled pill (bg + text) for tag badges. */
export function tagPill(name: string): string {
  return PILL[indexOf(name)];
}
