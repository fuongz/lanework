// The smallest reading of TOML the agent setup needs (FE-40): table headers,
// `key = value` lines, dotted and quoted keys, values that run over several
// lines, inline tables and arrays of tables — enough to find Codex's
// `[mcp_servers.*]`, `[plugins.*]`, `[projects."<path>"]`, `[[skills.config]]`,
// inline `[hooks]` and its top-level policies.
//
// ⚠️ Not a TOML parser, on purpose, and no dependency for one. A value comes
// back RAW, and the caller turns into a value only the string or boolean it
// asked for — `args`, `env` and `http_headers` are read past, never into.
// Anything this cannot read is skipped rather than guessed at.

export interface TomlEntry {
  /** The table and the key as one path: `["mcp_servers", "x", "url"]`. */
  path: string[];
  /** The value as written: `"https://…"`, `true`, `["a", "b"]`. */
  raw: string;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Walk `text` outside its strings, calling `visit` with each character and
 * its index; `visit` returning true stops the walk.
 *
 * ⚠️ Basic strings honour `\"`; literal strings have no escapes. A string
 * left open at the end of the text just ends the walk.
 */
export function outsideStrings(
  text: string,
  visit: (char: string, index: number) => boolean | undefined,
): void {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (visit(char, index)) return;
  }
}

/** The line up to a `#` that is not inside a string. */
export function stripComment(line: string): string {
  let end = line.length;
  outsideStrings(line, (char, index) => {
    if (char !== "#") return false;
    end = index;
    return true;
  });
  return line.slice(0, end);
}

/** `text` cut at every `separator` that is outside strings and brackets. */
export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  outsideStrings(text, (char, index) => {
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    return false;
  });
  parts.push(text.slice(start));
  return parts;
}

/** Whether a value opens more brackets than it closes, or a `"""` string. */
function unfinished(raw: string): boolean {
  for (const fence of ['"""', "'''"])
    if (raw.startsWith(fence)) return raw.split(fence).length < 3;
  let depth = 0;
  outsideStrings(raw, (char) => {
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    return false;
  });
  return depth > 0;
}

/** A string as written, unquoted: `"a\"b"` → `a"b`, `'C:\x'` → `C:\x`. */
export function tomlString(raw: string): string | null {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : null;
    } catch {
      // A TOML escape JSON does not know (`\e`, `\x1b`): as written.
      return text.slice(1, -1);
    }
  }
  return null;
}

export function tomlBool(raw: string): boolean | null {
  const text = raw.trim();
  return text === "true" ? true : text === "false" ? false : null;
}

/** `a."b.c".d` → `["a", "b.c", "d"]`; null for a key this cannot read. */
export function tomlKey(text: string): string[] | null {
  const parts = splitTop(text, ".").map((part) => part.trim());
  const keys: string[] = [];
  for (const part of parts) {
    const quoted = tomlString(part);
    if (quoted !== null) keys.push(quoted);
    else if (BARE_KEY.test(part)) keys.push(part);
    else return null;
  }
  return keys.length ? keys : null;
}

/** Index of the `=` that ends a key, outside quoted key parts; -1 for none. */
function equalsAt(line: string): number {
  let at = -1;
  outsideStrings(line, (char, index) => {
    if (char !== "=") return false;
    at = index;
    return true;
  });
  return at;
}

function push(entries: TomlEntry[], path: string[], raw: string): void {
  // An inline table: its keys are this one's children.
  if (raw.startsWith("{") && raw.endsWith("}")) {
    for (const pair of splitTop(raw.slice(1, -1), ",")) {
      const at = equalsAt(pair);
      if (at < 0) continue;
      const key = tomlKey(pair.slice(0, at));
      if (key) push(entries, [...path, ...key], pair.slice(at + 1).trim());
    }
    return;
  }
  entries.push({ path, raw });
  // An array of inline tables — `Stop = [{ hooks = [...] }]` — files each
  // table under its index, as `[[Stop]]` would.
  if (raw.startsWith("[") && raw.endsWith("]"))
    splitTop(raw.slice(1, -1), ",").forEach((item, index) => {
      const value = item.trim();
      if (value.startsWith("{")) push(entries, [...path, `#${index}`], value);
    });
}

/**
 * `path` with the index of the array of tables each prefix names, if any:
 * a key under `[[a]]` lives in `a`'s LATEST table, `["a", "#1", …]`.
 */
function underArrays(path: string[], arrays: Map<string, number>): string[] {
  const resolved: string[] = [];
  for (const part of path) {
    resolved.push(part);
    const index = arrays.get(resolved.join("\n"));
    if (index !== undefined) resolved.push(`#${index}`);
  }
  return resolved;
}

/** Every `key = value` in `text`, with the table it sits in. */
export function tomlEntries(text: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  const lines = text.split(/\r?\n/);
  // A table this cannot name hides its keys rather than filing them under
  // the table before it.
  let table: string[] | null = [];
  /** Each array of tables seen, by path, and the index of its latest table. */
  const arrays = new Map<string, number>();
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index] ?? "").trim();
    if (!line) continue;
    // `[[x]]`: one more table in the array `x`, filed as `["x", "#n"]`.
    const array = /^\[\[(.+)\]\]$/.exec(line);
    if (array?.[1]) {
      const key = tomlKey(array[1]);
      if (!key) {
        table = null;
        continue;
      }
      const path = [
        ...underArrays(key.slice(0, -1), arrays),
        key[key.length - 1] as string,
      ];
      const next = (arrays.get(path.join("\n")) ?? -1) + 1;
      arrays.set(path.join("\n"), next);
      table = [...path, `#${next}`];
      continue;
    }
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      const key = tomlKey(header[1]);
      table = key && underArrays(key, arrays);
      continue;
    }
    const at = equalsAt(line);
    if (at < 0) continue;
    let raw = line.slice(at + 1).trim();
    while (unfinished(raw) && index + 1 < lines.length)
      raw += `\n${stripComment(lines[++index] ?? "")}`;
    const key = tomlKey(line.slice(0, at));
    if (table && key) push(entries, [...table, ...key], raw.trim());
  }
  return entries;
}
