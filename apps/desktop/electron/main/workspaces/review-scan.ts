/**
 * What a checklist item IS, in a review file.
 *
 * ⚠️ A PORT, not an invention. Every rule below is copied from the Lanework
 * board's `apps/local/src/lib/review-stats.ts` (`scanLines`, `scanTaskBlocks`),
 * which is the single definition both that board's renderer and its writer go
 * through. Four disagreeing regexes preceded it, and the two failures they
 * caused are worth restating because they are what these rules exist for:
 *
 *   - `- [ ]` inside a ```fence``` counted as an item but rendered as code, so a
 *     card documenting the checklist format could never reach 100%.
 *   - `> - [ ]` in a blockquote rendered as a real, clickable row but no writer
 *     matched it: the user ticked it, saved, and the tick vanished silently.
 *
 * ⚠️ If the board's copy changes, this one has to change with it. The gate that
 * catches a drift is `tests/review-scan.spec.ts`, which runs these functions
 * over THIS repo's own cards — real files written by that board — rather than
 * over fixtures typed here from memory.
 */

/** What a scanned line turned out to be. */
export type ScanKind = "task" | "bullet" | "heading" | "text";

export interface ScanLine {
  /** 1-based line number in the text handed to the scanner. */
  line: number;
  kind: ScanKind;
  /** Blockquote prefix as written (e.g. `"> "`), empty when the line isn't quoted. */
  quote: string;
  /** Indent width of the list marker, after the quote prefix. 0 for non-list lines. */
  indent: number;
  /** Headings only: 1 for `#`, 2 for `##`, … 0 for every other kind. */
  level: number;
  /** Task/bullet: text after the marker (and after `[x] `). Heading: its text. */
  content: string;
  /** Tasks only. */
  checked: boolean;
  /** Tasks only: the `**D1.**`-style ordinal that identifies this item, or null. */
  id: string | null;
  /** Does this line END with the `*(dropped)*` marker? */
  dropped: boolean;
}

/** An item the card decided AGAINST — the third state, next to done and not-done. */
export const DROPPED_MARKER_RE = /\s*\*\(dropped\)\*\s*$/i;
/** The recommended option of a "pick ONE" group. */
export const RECOMMENDED_RE = /\s*\*\(recommended\)\*\s*$/i;
/** The parent bullet that opens a "pick ONE" group. */
export const PICK_ONE_BULLET_RE = /^pick\s+one\b/i;

const QUOTE_RE = /^(\s*(?:>\s?)+)/;
const FENCE_RE = /^\s*(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
/** `**D1.**`, `**V2.**`, `**B4a.**` — the handle every write uses. */
const ITEM_ID_RE = /^\*\*([A-Za-z]{1,4}\d+[a-z]?)[.)]?\*\*\s*/;

/** Extra indent that keeps a wrapped line inside its list item. */
export const CONTINUATION_INDENT = 2;

/**
 * Classify every line of `md`, skipping fenced code blocks entirely.
 *
 * A fence closes only on the same marker character, so a ``` block quoting a
 * ~~~ block doesn't end early. Indented (4-space) code blocks are NOT detected
 * — they are ambiguous with nested list continuation, and fenced blocks are
 * what review cards actually use.
 */
export function scanLines(md: string): ScanLine[] {
  const out: ScanLine[] = [];
  let fence: string | null = null;

  md.split("\n").forEach((raw, i) => {
    const fenceMatch = raw.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return; // the fence line itself is never content
    }
    if (fence !== null) return; // inside a code block — nothing here is markup

    const quote = raw.match(QUOTE_RE)?.[1] ?? "";
    const rest = quote ? raw.slice(quote.length) : raw;

    const heading = rest.match(HEADING_RE);
    if (heading) {
      out.push({
        line: i + 1,
        kind: "heading",
        quote,
        indent: 0,
        level: heading[1].length,
        content: heading[2],
        checked: false,
        id: null,
        dropped: false,
      });
      return;
    }

    const bullet = rest.match(BULLET_RE);
    if (!bullet) {
      if (rest.trim()) {
        out.push({
          line: i + 1,
          kind: "text",
          quote,
          // Leading whitespace, which for a plain line is what says whether it
          // continues the list item above it or starts a new block.
          indent: rest.length - rest.trimStart().length,
          level: 0,
          content: rest,
          checked: false,
          id: null,
          dropped: DROPPED_MARKER_RE.test(rest),
        });
      }
      return;
    }

    const task = bullet[2].match(TASK_RE);
    if (!task) {
      out.push({
        line: i + 1,
        kind: "bullet",
        quote,
        indent: bullet[1].length,
        level: 0,
        content: bullet[2],
        checked: false,
        id: null,
        dropped: false,
      });
      return;
    }

    const body = task[2];
    out.push({
      line: i + 1,
      kind: "task",
      quote,
      indent: bullet[1].length,
      level: 0,
      content: body.replace(ITEM_ID_RE, ""),
      checked: task[1] !== " ",
      id: body.match(ITEM_ID_RE)?.[1] ?? null,
      dropped: DROPPED_MARKER_RE.test(body),
    });
  });

  return out;
}

export interface TaskBlock {
  task: ScanLine;
  /** Wrapped continuation lines of the item's own text, in order. */
  body: ScanLine[];
  /** The reviewer's `> note` lines attached to the item. */
  notes: ScanLine[];
  /** 1-based line where the whole block ends. */
  end: number;
  /** Is this item marked `*(dropped)*`, read off the LAST line of its text? */
  dropped: boolean;
}

/**
 * Every checklist item together with the lines that BELONG to it.
 *
 * ⚠️ "Where does an item end" was answered in two places once and they
 * disagreed: real cards wrap their decisions over several lines, so appending a
 * `> note` "right after the checkbox line" spliced it into the MIDDLE of the
 * item's own sentence. A block runs while lines are CONTIGUOUS (a blank line
 * ends it, exactly as markdown reads it): first the wrapped text, then notes.
 */
export function scanTaskBlocks(md: string): TaskBlock[] {
  const scanned = scanLines(md);
  const blocks: TaskBlock[] = [];
  for (let i = 0; i < scanned.length; i++) {
    const task = scanned[i];
    if (task.kind !== "task" || task.quote) continue;
    const body: ScanLine[] = [];
    const notes: ScanLine[] = [];
    let end = task.line;
    for (let j = i + 1; j < scanned.length; j++) {
      const n = scanned[j];
      if (n.line !== end + 1) break;
      if (n.quote) notes.push(n);
      else if (
        n.kind === "text" &&
        notes.length === 0 &&
        n.indent >= task.indent + CONTINUATION_INDENT
      )
        body.push(n);
      else break;
      end = n.line;
      i = j;
    }
    const text = body.length ? body[body.length - 1] : task;
    blocks.push({ task, body, notes, end, dropped: text.dropped });
  }
  return blocks;
}
