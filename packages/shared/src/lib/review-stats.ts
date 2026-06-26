export interface ReviewStats {
  /** Total checklist items (`- [ ]` / `- [x]`). */
  total: number;
  /** Checked items (`- [x]`). */
  done: number;
  /** Blockquote note lines (`> …`) — reviewer decisions / disagreements. */
  notes: number;
}

const CHECKBOX = /^(\s*)[-*+]\s+\[( |x|X)\]/;
const NOTE = /^\s*>\s?\S/;

const PICK_ONE_RE = /\b(?:pick|choose|select)\s+(?:exactly\s+)?one\b/i;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const CHECKBOX_RE = /^\[[ xX]\]\s/;

/**
 * Find task lines that belong to a "pick one" decision group, keyed by source
 * line (1-based) → a shared group id (only the least-indented members count, so
 * nested sub-tasks stay independent). Two markups are recognized:
 *
 *   1. Preferred — a task list nested under a `Pick one:` bullet. Only the
 *      indented options join; a follow-up at the outer level stays independent.
 *   2. Legacy — top-level task items under a heading that says "pick one".
 *
 * A group counts as a SINGLE decision for progress purposes (see
 * `parseReviewStats`): N options collapse to one item, done once any is picked.
 */
export function parseRadioGroups(markdown: string): Record<number, string> {
  const lines = markdown.split("\n");
  const perGroup = new Map<string, { line: number; indent: number }[]>();
  const add = (id: string, line: number, indent: number) => {
    const arr = perGroup.get(id) ?? [];
    arr.push({ line, indent });
    perGroup.set(id, arr);
  };

  let headingGroup: string | null = null;
  let nested: { indent: number; id: string } | null = null;

  lines.forEach((raw, i) => {
    const heading = raw.match(HEADING_RE);
    if (heading) {
      headingGroup = PICK_ONE_RE.test(heading[1]) ? `h${i + 1}` : null;
      nested = null;
      return;
    }
    const bullet = raw.match(BULLET_RE);
    if (!bullet) return;
    const indent = bullet[1].length;
    const isTask = CHECKBOX_RE.test(bullet[2]);

    if (nested && indent <= nested.indent) nested = null;

    if (!isTask) {
      if (PICK_ONE_RE.test(bullet[2])) nested = { indent, id: `n${i + 1}` };
      return;
    }

    if (nested && indent > nested.indent) add(nested.id, i + 1, indent);
    else if (headingGroup) add(headingGroup, i + 1, indent);
  });

  const result: Record<number, string> = {};
  for (const [id, items] of perGroup) {
    if (items.length < 2) continue; // a lone option isn't a choice
    const minIndent = Math.min(...items.map((it) => it.indent));
    for (const it of items) if (it.indent === minIndent) result[it.line] = id;
  }
  return result;
}

/**
 * Parse a review markdown file into the metrics shown on its card. Each "pick
 * one" group counts as a single item (done once any option is selected) so the
 * total reflects decisions, not the raw number of radio options.
 */
export function parseReviewStats(markdown: string): ReviewStats {
  const groups = parseRadioGroups(markdown);
  let total = 0;
  let done = 0;
  let notes = 0;
  const groupChosen = new Map<string, boolean>();

  markdown.split("\n").forEach((line, i) => {
    const cb = line.match(CHECKBOX);
    if (cb) {
      const checked = cb[2] !== " ";
      const gid = groups[i + 1];
      if (gid) {
        if (!groupChosen.has(gid)) {
          groupChosen.set(gid, false);
          total++; // count the group once
        }
        if (checked) groupChosen.set(gid, true);
      } else {
        total++;
        if (checked) done++;
      }
      return;
    }
    if (NOTE.test(line)) notes++;
  });

  for (const chosen of groupChosen.values()) if (chosen) done++;
  return { total, done, notes };
}

export function progressPercent(stats: ReviewStats | null): number | null {
  if (!stats || stats.total === 0) return null;
  return Math.round((stats.done / stats.total) * 100);
}
