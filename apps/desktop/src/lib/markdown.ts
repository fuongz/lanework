/**
 * A deliberately small Markdown reader for review-card bodies.
 *
 * ⚠️ It produces a BLOCK LIST, never HTML. The renderer builds React elements
 * from these, so there is no `dangerouslySetInnerHTML` anywhere in the app and a
 * card body — which arrives from a service, over a network, written by anyone
 * on the account — cannot inject markup. That constraint is the reason this
 * exists at all rather than a library.
 *
 * ⚠️ It covers what these cards actually contain: headings, paragraphs, lists,
 * fenced code, quotes and tables. Anything it does not know stays literal text,
 * which is the correct failure for a document nobody can re-edit from here.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | LinkSpan;

/**
 * `[text](href)`, or `[[name]]` (`wiki`) — only when asked for (FE-36).
 * `raw` is the link as written, for a reader that does not follow it.
 */
export interface LinkSpan {
  kind: "link";
  text: string;
  href: string;
  wiki: boolean;
  raw: string;
}

export interface MarkdownOptions {
  /**
   * Read `[text](href)` and `[[name]]` as links (FE-36). Off by default: a
   * card body keeps every link exactly as written.
   */
  links?: boolean;
}

export type Block =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "code"; text: string; lang: string | null }
  | { kind: "table"; header: string[]; rows: string[][] };

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
/** The same, with links. Code comes first: a link inside it stays code. */
const INLINE_LINKS =
  /(`[^`]+`|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/** Split one line into spans. Unmatched text stays exactly as written. */
export function inlines(line: string, options: MarkdownOptions = {}): Inline[] {
  const spans: Inline[] = [];
  let at = 0;
  for (const match of line.matchAll(options.links ? INLINE_LINKS : INLINE)) {
    const start = match.index ?? 0;
    if (start > at) spans.push({ kind: "text", text: line.slice(at, start) });
    const token = match[0];
    const link = LINK.exec(token);
    if (token.startsWith("[[")) {
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
    else if (token.startsWith("`"))
      spans.push({ kind: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**"))
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

    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: Inline[][] = [read(bullet[1])];
      while (i + 1 < lines.length) {
        const next = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i + 1]);
        if (!next) break;
        items.push(read(next[1]));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
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
