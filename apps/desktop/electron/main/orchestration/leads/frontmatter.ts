// The frontmatter of a team lead file (FE-88): a strict subset of YAML.
//
// A repo's `.lanework/leads/<id>.md` starts with a `---` block, then the
// lead's instructions as markdown. The block needs only what a team lead
// holds, so this reads only that:
//
// - `key: value` maps, nested by indentation (spaces, never tabs);
// - `- item` lists of scalars or of maps, and `[a, b]` / `[]` inline lists;
// - scalars: plain text, "double" or 'single' quoted, numbers, true/false,
//   null or ~; a ` #` after a plain value starts a comment.
//
// Anything else (block scalars, anchors, tags, inline maps) is refused with
// the line it is on, never guessed at. No dependency: the app ships none for
// YAML, and a full parser would accept far more than a lead may say.
//
// Nothing here imports Electron.

export class FrontmatterError extends Error {
  override name = "FrontmatterError";
}

function fail(line: number, message: string): never {
  throw new FrontmatterError(line ? `Line ${line}: ${message}` : message);
}

interface Line {
  /** 1-based, in the whole file. */
  no: number;
  indent: number;
  text: string;
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/;
const ITEM = /^-(?:[ ]+(.*))?$/;

/** A plain object with no prototype, so no key can reach `Object.prototype`. */
const record = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>;

/** Cut a ` #` comment off a plain value; quoted values keep theirs. */
function uncomment(text: string): string {
  const at = text.search(/(^|[ ])#/);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

function scalar(raw: string, no: number): unknown {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    if (end <= 0) fail(no, "a double-quoted value is not closed");
    const rest = text.slice(end + 1).trim();
    if (rest && !rest.startsWith("#"))
      fail(no, "unexpected text after a quoted value");
    try {
      return JSON.parse(text.slice(0, end + 1)) as string;
    } catch {
      fail(no, "a double-quoted value has a bad escape");
    }
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(text);
    if (!match) fail(no, "a single-quoted value is not closed");
    return (match[1] ?? "").replace(/''/g, "'");
  }
  const plain = uncomment(text);
  if (plain.startsWith("[")) {
    if (!plain.endsWith("]")) fail(no, "an inline list is not closed");
    return inlineList(plain.slice(1, -1), no);
  }
  if (plain === "{}") return record();
  if (plain.startsWith("{"))
    fail(no, "inline maps are not supported; write one key per line");
  if (/^[|>]/.test(plain))
    fail(
      no,
      "multi-line values are not supported; put long text in the body below the frontmatter",
    );
  if (/^[&*!%@`]/.test(plain))
    fail(no, `values may not start with "${plain[0]}"`);
  if (plain === "" || plain === "null" || plain === "~") return null;
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

/** `a, "b, c", 'd'` → its scalars; nested lists are refused. */
function inlineList(body: string, no: number): unknown[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += body[++index] ?? "";
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    if (char === "[" || char === "{")
      fail(no, "nested inline lists or maps are not supported");
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) fail(no, "a quoted value in an inline list is not closed");
  items.push(current);
  if (items.length === 1 && !items[0]?.trim()) return [];
  return items.map((item) => {
    if (!item.trim()) fail(no, "an inline list has an empty item");
    return scalar(item, no);
  });
}

class Reader {
  private index = 0;
  constructor(private readonly lines: Line[]) {}

  private peek(): Line | undefined {
    return this.lines[this.index];
  }

  /** The whole block: a map at the top. */
  document(): Record<string, unknown> {
    const first = this.peek();
    if (!first) return record();
    if (first.indent !== 0)
      fail(first.no, "the first key must not be indented");
    if (ITEM.test(first.text))
      fail(first.no, "the frontmatter must be keys, not a list");
    const value = this.map(0);
    const rest = this.peek();
    if (rest) fail(rest.no, "unexpected indentation");
    return value;
  }

  /** The value under a key whose own line had nothing after the colon. */
  private nested(parent: number): unknown {
    const next = this.peek();
    if (!next) return null;
    if (next.indent > parent)
      return ITEM.test(next.text)
        ? this.list(next.indent)
        : this.map(next.indent);
    // YAML lets a list sit at its key's own indentation.
    if (next.indent === parent && ITEM.test(next.text))
      return this.list(parent);
    return null;
  }

  private map(indent: number): Record<string, unknown> {
    const out = record();
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail(line.no, "unexpected indentation");
      if (ITEM.test(line.text)) return out;
      const match = KEY.exec(line.text);
      if (!match)
        fail(
          line.no,
          `expected "key: value", got ${JSON.stringify(line.text.slice(0, 40))}`,
        );
      const key = match[1] as string;
      if (key in out) fail(line.no, `"${key}" is set twice`);
      this.index++;
      const rest = match[2];
      out[key] =
        rest === undefined || uncomment(rest) === ""
          ? this.nested(indent)
          : scalar(rest, line.no);
    }
  }

  private list(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) return out;
      if (line.indent > indent) fail(line.no, "unexpected indentation");
      const match = ITEM.exec(line.text);
      if (!match) return out;
      const rest = match[1];
      if (rest === undefined || uncomment(rest) === "") {
        this.index++;
        const next = this.peek();
        out.push(
          next && next.indent > indent
            ? ITEM.test(next.text)
              ? this.list(next.indent)
              : this.map(next.indent)
            : null,
        );
        continue;
      }
      if (KEY.test(rest) && !/^["']/.test(rest)) {
        // `- key: value` opens a map whose keys line up with `key`.
        const column = indent + line.text.indexOf(rest);
        this.lines[this.index] = { no: line.no, indent: column, text: rest };
        out.push(this.map(column));
        continue;
      }
      if (ITEM.test(rest))
        fail(line.no, "nested lists on one line are not supported");
      this.index++;
      out.push(scalar(rest, line.no));
    }
  }
}

/** Split a lead file into its frontmatter block and the markdown after it. */
export function splitFrontmatter(source: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const all = text.split("\n");
  if (all[0]?.trimEnd() !== "---")
    fail(0, 'The file must start with a "---" line, then the frontmatter');
  const close = all.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---",
  );
  if (close === -1) fail(0, 'The frontmatter is not closed with a "---" line');
  const lines: Line[] = [];
  for (let index = 1; index < close; index++) {
    const raw = all[index] as string;
    const no = index + 1;
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
    const lead = /^[ \t]*/.exec(raw)?.[0] ?? "";
    if (lead.includes("\t")) fail(no, "indent with spaces, not tabs");
    lines.push({
      no,
      indent: lead.length,
      text: raw.slice(lead.length).trimEnd(),
    });
  }
  return {
    frontmatter: new Reader(lines).document(),
    body: all
      .slice(close + 1)
      .join("\n")
      .trim(),
  };
}
