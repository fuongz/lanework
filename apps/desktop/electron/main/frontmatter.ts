// The one place a Markdown file's `---` frontmatter fence is found (FE-82/D6).
//
// The agent-setup, memory and instructions readers each read different fields
// out of it, and keep doing that themselves. Only where the fence starts and
// ends is shared, so the three cannot disagree on a BOM, CRLF line ends or a
// fence on the last line.

/** An opening `---`, the frontmatter, then a closing `---` line. */
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A file's `---` frontmatter, without the fences, and the rest.
 *
 * A leading byte-order mark is dropped first, from the body too. The fences
 * must open the file; the closing one may end it.
 *
 * @returns `frontmatter: null` when the file has none, and then `body` is the
 *   whole file.
 */
export function splitFrontmatter(source: string): {
  frontmatter: string | null;
  body: string;
} {
  const text = source.replace(/^﻿/, "");
  const match = FENCE.exec(text);
  return match
    ? { frontmatter: match[1] ?? "", body: text.slice(match[0].length) }
    : { frontmatter: null, body: text };
}
