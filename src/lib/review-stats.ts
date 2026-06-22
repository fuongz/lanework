export interface ReviewStats {
  /** Total checklist items (`- [ ]` / `- [x]`). */
  total: number;
  /** Checked items (`- [x]`). */
  done: number;
  /** Blockquote note lines (`> …`) — reviewer decisions / disagreements. */
  notes: number;
}

const CHECKBOX = /^\s*[-*]\s+\[( |x|X)\]/;
const NOTE = /^\s*>\s?\S/;

/** Parse a review markdown file into the metrics shown on its card. */
export function parseReviewStats(markdown: string): ReviewStats {
  let total = 0;
  let done = 0;
  let notes = 0;
  for (const line of markdown.split("\n")) {
    const cb = line.match(CHECKBOX);
    if (cb) {
      total++;
      if (cb[1] !== " ") done++;
      continue;
    }
    if (NOTE.test(line)) notes++;
  }
  return { total, done, notes };
}

export function progressPercent(stats: ReviewStats | null): number | null {
  if (!stats || stats.total === 0) return null;
  return Math.round((stats.done / stats.total) * 100);
}
