// Structural search (FE-151), Electron-free for the kit (FE-152): an
// ast-grep pattern over a folder's files.
//
// The files are fs-kit's list (`.gitignore` respected), kept to the
// languages ast-grep parses here. Each one is read and parsed off the main
// thread (`parseAsync`, libuv's pool) in batches, and the signal is checked
// between batches. A symlink is never read: the folder's scope ends at it.
//
// NOTE: Not `findInFiles`. It is about as fast, but runs to the end of its
// paths with no way to stop it, and the caps, the size limit and the abort
// all need to cut in between files.
//
// NOTE: `../main/structural-search.ts` still holds a copy of this core for
// its IPC handler; it should import `searchStructuralIn` from here instead.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileMatch,
  MatchLine,
  SearchStructuralOptions,
  StructuralLang,
} from "../../shared/fs-search";
import { FsSearchTimeoutError, listFiles } from "../main/fs-kit";
import type { AstGrepModule } from "../main/native";
import { appNatives, type KitNatives } from "./natives";

/** The most files with matches returned, unless the caller says fewer. */
const MAX_FILES = 200;
/** The most matching lines over all files. */
const MAX_MATCHES = 2_000;
/** The whole search, listing included. */
const TIMEOUT_MS = 10_000;
/** A larger file is skipped: generated or minified, and slow to parse. */
const FILE_BYTES_MAX = 1024 * 1024;
/** Files read and parsed at once. */
const BATCH = 64;
/** The longest line kept; a longer one is cut to a window around its first match. */
const LINE_MAX = 400;
/** How much of a cut line is kept before its first match. */
const LINE_LEAD = 80;

/** Every language a pattern may name, as `shared/fs-search.ts` lists them. */
export const STRUCTURAL_LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "css",
  "html",
  "python",
  "rust",
  "go",
] as const satisfies readonly StructuralLang[];

interface LangSpec {
  /** ast-grep's name for it. */
  astGrep: string;
  /** What it reads in, lower case, without the dot. */
  extensions: readonly string[];
  /** Built into ast-grep; the others are dynamic and may be missing. */
  builtIn: boolean;
  /**
   * What ast-grep turns `$` into before parsing a pattern, where `$` is not
   * a word character of the language.
   */
  expando?: string;
  /** Name for an error message. */
  label: string;
}

const LANGS: Record<StructuralLang, LangSpec> = {
  ts: {
    astGrep: "TypeScript",
    extensions: ["ts", "mts", "cts"],
    builtIn: true,
    label: "TypeScript",
  },
  tsx: { astGrep: "Tsx", extensions: ["tsx"], builtIn: true, label: "TSX" },
  js: {
    astGrep: "JavaScript",
    extensions: ["js", "mjs", "cjs"],
    builtIn: true,
    label: "JavaScript",
  },
  // NOTE: ast-grep's JavaScript grammar parses JSX.
  jsx: {
    astGrep: "JavaScript",
    extensions: ["jsx"],
    builtIn: true,
    label: "JSX",
  },
  css: {
    astGrep: "Css",
    extensions: ["css"],
    builtIn: true,
    expando: "_",
    label: "CSS",
  },
  html: {
    astGrep: "Html",
    extensions: ["html", "htm"],
    builtIn: true,
    label: "HTML",
  },
  json: {
    astGrep: "json",
    extensions: ["json"],
    builtIn: false,
    label: "JSON",
  },
  python: {
    astGrep: "python",
    extensions: ["py", "pyi"],
    builtIn: false,
    expando: "µ",
    label: "Python",
  },
  rust: {
    astGrep: "rust",
    extensions: ["rs"],
    builtIn: false,
    expando: "µ",
    label: "Rust",
  },
  go: {
    astGrep: "go",
    extensions: ["go"],
    builtIn: false,
    expando: "µ",
    label: "Go",
  },
};

/** A pattern that no searched language parses. */
export class StructuralPatternError extends Error {}

/** ast-grep, or the language a pattern names, is not loaded here. */
export class StructuralUnavailableError extends Error {}

export interface StructuralRunOptions extends SearchStructuralOptions {
  signal?: AbortSignal;
  /** Milliseconds; {@link TIMEOUT_MS} when unset. */
  timeoutMs?: number;
  /** The most files with matches; {@link MAX_FILES} when unset, never more. */
  maxFiles?: number;
  /** Where ast-grep comes from; {@link appNatives} when unset. */
  natives?: KitNatives;
}

/** The languages a search covers: `lang`, or every one loaded here. */
function langsFor(
  lang: StructuralLang | undefined,
  natives: KitNatives,
): StructuralLang[] {
  const loaded = new Set(natives.astGrepLangs());
  const usable = (key: StructuralLang) =>
    LANGS[key].builtIn || loaded.has(LANGS[key].astGrep);
  if (lang) {
    if (!usable(lang))
      throw new StructuralUnavailableError(
        `${LANGS[lang].label} is not available here.`,
      );
    return [lang];
  }
  return STRUCTURAL_LANGS.filter(usable);
}

/** Whether `pattern` parses as `spec`'s code; ast-grep's complaint if not. */
function patternError(
  napi: AstGrepModule,
  spec: LangSpec,
  pattern: string,
): string | null {
  try {
    // ast-grep refuses some patterns outright (no node, several nodes).
    napi.parse(spec.astGrep, "").root().findAll(pattern);
    const source = spec.expando
      ? pattern.replaceAll("$", spec.expando)
      : pattern;
    const root = napi.parse(spec.astGrep, source).root();
    // A pattern with a syntax error matches nothing, silently.
    // NOTE: HTML leaves a missing end tag out of a `<div>` pattern, which is
    // still a usable one; only its ERROR nodes count.
    if (hasSyntaxError(root, spec.astGrep !== "Html"))
      return `That pattern is not valid ${spec.label}.`;
    // HTML takes any text as a text node; a pattern there starts with a tag.
    if (
      spec.astGrep === "Html" &&
      root.children().every((child) => child.kind() === "text")
    )
      return "An HTML pattern starts with a tag.";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Node = ReturnType<ReturnType<AstGrepModule["parse"]>["root"]>;

/** An ERROR node, or (with `missing`) a node the parser made up. */
function hasSyntaxError(node: Node, missing: boolean): boolean {
  if (node.kind() === "ERROR") return true;
  if (missing && node.isLeaf()) {
    const { start, end } = node.range();
    if (start.index === end.index && node.text() === "") return true;
  }
  return node.children().some((child) => hasSyntaxError(child, missing));
}

/**
 * The longest plain word of `pattern` (not a metavariable): a file without
 * it cannot match, so it is never parsed. Null when there is none.
 */
function requiredWord(pattern: string): string | null {
  let best: string | null = null;
  for (const [word] of pattern.matchAll(/(?<![$\w])[A-Za-z_]\w*/g))
    if (word.length >= 2 && word.length > (best?.length ?? 0)) best = word;
  return best;
}

/**
 * Search the files under `root` for the ast-grep `pattern`.
 *
 * Every language ast-grep has here, or only `lang`. A language the pattern
 * does not parse in is left out; when that is all of them, the search
 * throws. Files over 1 MB, and symlinks, are skipped.
 *
 * Stops at `maxFiles` ({@link MAX_FILES} at most) files or {@link MAX_MATCHES} lines, and at the
 * timeout, with the last file marked `truncated`. A timeout before any match
 * throws, so "nothing found" is never a guess.
 *
 * @throws {StructuralPatternError} When no language parses the pattern.
 * @throws {FsSearchTimeoutError} When the time ran out before any match.
 * @throws The signal's reason when aborted.
 */
export async function searchStructuralIn(
  root: string,
  pattern: string,
  options: StructuralRunOptions = {},
): Promise<FileMatch[]> {
  if (!pattern.trim()) return [];
  const natives = options.natives ?? appNatives;
  const napi = natives.astGrep();
  if (!napi)
    throw new StructuralUnavailableError(
      "Structural search is not available here.",
    );
  const maxFiles = Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES);

  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const stopped = () => {
    if (options.signal?.aborted) throw options.signal.reason;
    return timeout.aborted;
  };

  const langs = langsFor(options.lang, natives);
  const byExtension = new Map<string, LangSpec>();
  for (const key of langs)
    for (const extension of LANGS[key].extensions)
      byExtension.set(extension, LANGS[key]);

  let listed: string[];
  try {
    listed = (await listFiles(root, { signal })).files;
  } catch (error) {
    if (stopped()) throw new FsSearchTimeoutError("The search took too long.");
    throw error;
  }
  const files: { path: string; spec: LangSpec }[] = [];
  for (const path of listed) {
    const dot = path.lastIndexOf(".");
    if (dot <= path.lastIndexOf("/")) continue;
    const spec = byExtension.get(path.slice(dot + 1).toLowerCase());
    if (spec) files.push({ path, spec });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Only the languages there are files for are checked, and kept when the
  // pattern parses in them.
  const accepted = new Set<LangSpec>();
  const errors: string[] = [];
  for (const spec of new Set(files.map((file) => file.spec))) {
    const error = patternError(napi, spec, pattern);
    if (error === null) accepted.add(spec);
    else errors.push(error.split("\n")[0] ?? error);
  }
  if (files.length > 0 && accepted.size === 0)
    throw new StructuralPatternError(
      errors.length === 1
        ? errors[0]
        : "That pattern does not parse as code in any of this folder's languages. Check its brackets and quotes.",
    );

  const word = requiredWord(pattern);
  const found: FileMatch[] = [];
  let matches = 0;
  let timedOut = false;
  const searched = files.filter((file) => accepted.has(file.spec));
  outer: for (let at = 0; at < searched.length; at += BATCH) {
    if (stopped()) {
      timedOut = true;
      break;
    }
    const batch = await Promise.all(
      searched
        .slice(at, at + BATCH)
        .map((file) => matchFile(napi, root, file, pattern, word)),
    );
    for (const result of batch) {
      if (!result) continue;
      if (found.length >= maxFiles) {
        const last = found.at(-1);
        if (last) last.truncated = true;
        break outer;
      }
      const room = MAX_MATCHES - matches;
      if (result.lines.length > room) {
        result.lines = result.lines.slice(0, room);
        result.truncated = true;
      }
      found.push(result);
      matches += result.lines.length;
      if (matches >= MAX_MATCHES) {
        result.truncated = true;
        break outer;
      }
    }
  }
  if (timedOut || stopped()) {
    const last = found.at(-1);
    if (!last) throw new FsSearchTimeoutError("The search took too long.");
    last.truncated = true;
  }
  return found;
}

/**
 * `file`'s matching lines, or null when it has none, is too large, or
 * cannot be read or parsed.
 */
async function matchFile(
  napi: AstGrepModule,
  root: string,
  file: { path: string; spec: LangSpec },
  pattern: string,
  word: string | null,
): Promise<FileMatch | null> {
  const full = join(root, file.path);
  let source: string;
  try {
    // lstat: a symlink may lead out of the folder, and is not followed.
    const info = await lstat(full);
    if (!info.isFile() || info.size > FILE_BYTES_MAX) return null;
    source = await readFile(full, "utf8");
  } catch {
    return null;
  }
  if (word !== null && !source.includes(word)) return null;
  let nodes: Node[];
  try {
    const parsed = await napi.parseAsync(file.spec.astGrep, source);
    nodes = parsed.root().findAll(pattern);
  } catch {
    return null;
  }
  if (nodes.length === 0) return null;

  // ast-grep's positions are UTF-16, as JS strings are: they index `source`.
  const byLine = new Map<
    number,
    { start: number; ranges: [number, number][] }
  >();
  for (const node of nodes) {
    const { start, end } = node.range();
    let entry = byLine.get(start.line);
    if (!entry) {
      entry = { start: start.index - start.column, ranges: [] };
      byLine.set(start.line, entry);
    }
    // A match running over several lines is marked to its first line's end.
    entry.ranges.push([
      start.column,
      end.line === start.line ? end.column : Number.POSITIVE_INFINITY,
    ]);
  }
  const lines: MatchLine[] = [];
  for (const [line, { start, ranges }] of [...byLine].sort(
    (a, b) => a[0] - b[0],
  )) {
    const newline = source.indexOf("\n", start);
    const text = source
      .slice(start, newline === -1 ? undefined : newline)
      .replace(/\r$/, "");
    lines.push(toLine(text, line + 1, mergeRanges(ranges, text.length)));
  }
  return { path: file.path, lines, truncated: false };
}

/** Sorted, clamped to `length`, and nested or overlapping ones joined. */
function mergeRanges(
  ranges: [number, number][],
  length: number,
): [number, number][] {
  const sorted = ranges
    .map(([start, end]): [number, number] => [
      Math.min(start, length),
      Math.min(end, length),
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * One match line, a long one cut to a window around its first match.
 *
 * NOTE: The same cut as fs-kit's `searchText` makes, so both modes show a
 * minified line alike.
 */
function toLine(
  text: string,
  line: number,
  ranges: [number, number][],
): MatchLine {
  if (text.length <= LINE_MAX) return { line, text, ranges };
  let from = Math.max(0, (ranges[0]?.[0] ?? 0) - LINE_LEAD);
  let to = Math.min(text.length, from + LINE_MAX);
  // Never cut a surrogate pair in half.
  if (isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (isLowSurrogate(text.charCodeAt(to))) to -= 1;
  return {
    line,
    text: text.slice(from, to),
    ranges: ranges
      .filter(([start]) => start >= from && start < to)
      .map(([start, end]): [number, number] => [
        start - from,
        Math.min(end, to) - from,
      ]),
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
