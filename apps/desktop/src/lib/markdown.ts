// A small Markdown reader for review-card bodies.
//
// NOTE: It produces a BLOCK LIST, never HTML. The renderer builds React
// elements from these, so there is no `dangerouslySetInnerHTML` anywhere in
// the app, and a card body — which arrives from a service, over a network,
// written by anyone on the account — cannot inject markup. That constraint is
// why this exists rather than a library.
//
// It covers what these cards contain: headings, paragraphs, lists, fenced
// code, quotes and tables. Anything it does not know stays literal text, the
// right failure for a document nobody can re-edit from here.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | LinkSpan
  | ImageSpan;

/**
 * `[text](href)`, or `[[name]]` (`wiki`), read only when asked for.
 *
 * `raw` is the link as written, for a reader that does not follow it.
 */
export interface LinkSpan {
  kind: "link";
  text: string;
  href: string;
  wiki: boolean;
  raw: string;
}

/**
 * `![alt](src)`, read only with links. `raw` is the image as written, for a
 * reader that does not draw it.
 */
export interface ImageSpan {
  kind: "image";
  alt: string;
  src: string;
  raw: string;
}

interface MarkdownOptions {
  /**
   * Reads `[text](href)` and `[[name]]` as links, and `![alt](src)` as an
   * image. Off by default: a card
   * body keeps every link as written.
   */
  links?: boolean;
}

export type Block =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | ListBlock
  | { kind: "quote"; spans: Inline[] }
  | { kind: "code"; text: string; lang: string | null }
  | { kind: "table"; header: string[]; rows: string[][] };

/**
 * A list. `start` is the first item's number, so a list written `3.`, `4.`
 * counts from 3. An item's `children` is the list indented under it.
 */
export interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export interface ListItem {
  spans: Inline[];
  children: ListBlock | null;
}

/** A list item line: indent, marker (`-`, `*`, `+`, `1.`, `1)`), text. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Columns of leading whitespace, a tab counting as four. */
const indentOf = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
};

/**
 * A code span, as Markdown has it: a run of backticks, then everything up to
 * a run of the SAME length — so `` `x` `` is code that shows its backticks.
 *
 * NOTE: Not `` `[^`]+` ``, which pairs the inner "` `" of `` `` `x` `` `` into
 * two code spans of one space each and leaves `x` as plain text. The run is
 * group 2 in both patterns below.
 */
const CODE_SPAN = "(?<!`)(`+)(?!`)(?:.+?)(?<!`)\\2(?!`)";
const INLINE = new RegExp(
  `(${CODE_SPAN}|\\*\\*[^*]+\\*\\*|\\*[^*\\n]+\\*)`,
  "g",
);
/**
 * The same, with links and images. Code comes first: a link inside it stays
 * code. An image comes before a link, or its `!` would be left as text.
 */
const INLINE_LINKS = new RegExp(
  `(${CODE_SPAN}|!\\[[^\\]\\n]*\\]\\([^)\\s]+\\)|\\[\\[[^\\]\\n]+\\]\\]|\\[[^\\]\\n]+\\]\\([^)\\s]+\\)|\\*\\*[^*]+\\*\\*|\\*[^*\\n]+\\*)`,
  "g",
);
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const IMAGE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/;

/** Splits one line into spans. Unmatched text stays as written. */
export function inlines(line: string, options: MarkdownOptions = {}): Inline[] {
  const spans: Inline[] = [];
  let at = 0;
  for (const match of line.matchAll(options.links ? INLINE_LINKS : INLINE)) {
    const start = match.index ?? 0;
    if (start > at) spans.push({ kind: "text", text: line.slice(at, start) });
    const token = match[0];
    const link = LINK.exec(token);
    const image = IMAGE.exec(token);
    if (image)
      spans.push({
        kind: "image",
        alt: image[1] ?? "",
        src: image[2] ?? "",
        raw: token,
      });
    else if (token.startsWith("[[")) {
      const name = token.slice(2, -2).trim();
      spans.push({
        kind: "link",
        text: name,
        href: name,
        wiki: true,
        raw: token,
      });
    } else if (link)
      spans.push({
        kind: "link",
        text: link[1] ?? "",
        href: link[2] ?? "",
        wiki: false,
        raw: token,
      });
    else if (token.startsWith("`")) {
      const run = match[2]?.length ?? 1;
      const body = token.slice(run, -run);
      // One space either side is padding, there so the code can start or
      // end with a backtick — unless the whole span is spaces.
      const padded =
        body.length > 1 &&
        body.startsWith(" ") &&
        body.endsWith(" ") &&
        body.trim() !== "";
      spans.push({ kind: "code", text: padded ? body.slice(1, -1) : body });
    } else if (token.startsWith("**"))
      spans.push({ kind: "strong", text: token.slice(2, -2) });
    else spans.push({ kind: "em", text: token.slice(1, -1) });
    at = start + token.length;
  }
  if (at < line.length) spans.push({ kind: "text", text: line.slice(at) });
  return spans.length ? spans : [{ kind: "text", text: line }];
}

const cells = (row: string): string[] =>
  row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseMarkdown(
  source: string,
  options: MarkdownOptions = {},
): Block[] {
  const read = (line: string) => inlines(line, options);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: "paragraph", spans: read(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```"))
        body.push(lines[i++]);
      blocks.push({ kind: "code", text: body.join("\n"), lang });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: read(heading[2]),
      });
      continue;
    }

    // A table needs its separator row to be a table at all; without it these
    // are just lines with pipes in them, and guessing would mangle prose.
    if (
      line.trim().startsWith("|") &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")
    ) {
      flush();
      const header = cells(line.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|"))
        rows.push(cells(lines[i++].trim()));
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      i = readList(lines, i, blocks, read) - 1;
      continue;
    }

    if (line.startsWith(">")) {
      flush();
      blocks.push({ kind: "quote", spans: read(line.replace(/^>\s?/, "")) });
      continue;
    }

    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/**
 * Reads the list starting at `lines[from]` into `blocks`, and returns the
 * index of the first line after it.
 *
 * NOTE: Indentation nests. An item indented deeper than the one above it
 * opens a list under that item, so `1.` with `   - a.` and `   - b.` under it
 * reads as one item holding two, not as three numbered items. A blank line
 * stays inside the list when the next line is another item or indented text;
 * an indented line that is not an item continues the item above it.
 */
function readList(
  lines: string[],
  from: number,
  blocks: Block[],
  read: (line: string) => Inline[],
): number {
  // Each open list, with the column its markers sit at; the root first.
  const stack: { list: ListBlock; indent: number }[] = [];
  const open = (marker: string, indent: number): ListBlock => {
    const ordered = /\d/.test(marker);
    const list: ListBlock = {
      kind: "list",
      ordered,
      start: ordered ? Number.parseInt(marker, 10) : 1,
      items: [],
    };
    stack.push({ list, indent });
    return list;
  };
  // Each item's text as written, read into spans once the list is whole.
  const raw = new Map<ListItem, string>();
  const lastItem = (): ListItem | undefined => {
    const top = stack.at(-1);
    return top?.list.items.at(-1);
  };

  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = indentOf(item[1]);
      const marker = item[2];
      if (!stack.length) blocks.push(open(marker, indent));
      else if (indent > (stack.at(-1)?.indent ?? 0)) {
        const parent = lastItem();
        if (parent && !parent.children) parent.children = open(marker, indent);
        else if (parent?.children) {
          // Back into a list that already exists under this item.
          stack.push({ list: parent.children, indent });
        }
      } else {
        while (stack.length > 1 && indent < (stack.at(-1)?.indent ?? 0))
          stack.pop();
        // `1.` after `-` (or back) at the top level starts another list.
        if (stack.length === 1 && /\d/.test(marker) !== stack[0].list.ordered)
          break;
      }
      const entry: ListItem = { spans: [], children: null };
      raw.set(entry, item[3]);
      stack.at(-1)?.list.items.push(entry);
      continue;
    }

    if (!line.trim()) {
      // A blank line ends the list unless the list carries on after it.
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      const after = lines[next] ?? "";
      if (LIST_ITEM.test(after) || (after.trim() && indentOf(after) > 0))
        continue;
      break;
    }

    // Indented text continues the deepest item above it.
    const target = lastItem();
    if (indentOf(line) > 0 && target) {
      raw.set(target, `${raw.get(target) ?? ""} ${line.trim()}`);
      continue;
    }
    break;
  }
  for (const [entry, text] of raw) entry.spans = read(text);
  return i;
}
