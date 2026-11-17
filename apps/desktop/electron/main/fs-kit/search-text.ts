// Content search with the bundled ripgrep (FE-149): `rg --json`, parsed as it
// streams, into one FileMatch per file.
import type { FileMatch, MatchLine } from "../../../shared/fs-search";
import { FsSearchTimeoutError, runRg } from "./rg";

export interface SearchTextRunOptions {
  /** A literal, never a pattern. Wins over `regex`. */
  fixed?: boolean;
  /** A regular expression (ripgrep's syntax). A literal when unset. */
  regex?: boolean;
  /** False (the default) ignores case. */
  caseSensitive?: boolean;
  /** ripgrep globs; a leading `!` excludes. */
  globs?: string[];
  /** The most files returned; 200 when unset. */
  maxFiles?: number;
  /** The most matching lines over all files; 2000 when unset. */
  maxMatches?: number;
  /** Milliseconds; 10 s when unset. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The longest line kept; a longer one is cut to a window around its first match. */
const LINE_MAX = 400;
/** How much of a cut line is kept before its first match. */
const LINE_LEAD = 80;

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgEvent {
  type: string;
  data: {
    path?: RgText;
    lines?: RgText;
    line_number?: number | null;
    submatches?: { start: number; end: number }[];
  };
}

/**
 * Search the files under `root` for `query`.
 *
 * What `rg` finds by default: `.gitignore` (and `.ignore`, `.rgignore`)
 * respected, hidden files and binary files skipped, symlinks not followed.
 * A user's ripgrep config is never read (`--no-config`).
 *
 * The search stops at `maxFiles` files or `maxMatches` lines, and at
 * `timeoutMs`: the child is killed and what was found is returned, with the
 * last file marked `truncated`. A timeout before any match throws instead,
 * so "nothing found" is never a guess.
 *
 * @throws {FsSearchTimeoutError} When the time ran out before any match.
 * @throws {RipgrepMissingError} When `rg` is missing.
 * @throws The signal's reason when aborted; the child is killed first.
 */
export async function searchText(
  root: string,
  query: string,
  options: SearchTextRunOptions = {},
): Promise<FileMatch[]> {
  if (!query) return [];
  const maxFiles = options.maxFiles ?? 200;
  const maxMatches = options.maxMatches ?? 2000;
  const literal = options.fixed === true || options.regex !== true;
  const args = [
    "--json",
    literal ? "--fixed-strings" : "--no-fixed-strings",
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  for (const glob of options.globs ?? []) args.push("--glob", glob);
  // `-e` keeps a query starting with `-` a query; `.` keeps rg off stdin.
  args.push("--regexp", query, "--", ".");

  const files: FileMatch[] = [];
  let current: FileMatch | null = null;
  let matches = 0;
  const result = await runRg(args, {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
    onLine: (raw) => {
      if (!raw.startsWith('{"type":"match"')) return undefined;
      let event: RgEvent;
      try {
        event = JSON.parse(raw) as RgEvent;
      } catch {
        return undefined;
      }
      const path = event.data.path?.text;
      const text = event.data.lines?.text;
      // A path or line that is not UTF-8 arrives as bytes; it cannot be
      // shown as text, so it is left out.
      if (path === undefined || text === undefined) return undefined;
      const relative = normalize(path);
      if (current?.path !== relative) {
        if (files.length >= maxFiles) {
          if (current) current.truncated = true;
          return false;
        }
        current = { path: relative, lines: [], truncated: false };
        files.push(current);
      }
      current.lines.push(
        toLine(text, event.data.line_number ?? 0, event.data.submatches ?? []),
      );
      matches += 1;
      if (matches >= maxMatches) {
        current.truncated = true;
        return false;
      }
      return undefined;
    },
  });
  if (result.timedOut) {
    const last = files.at(-1);
    if (!last) throw new FsSearchTimeoutError("The search took too long.");
    last.truncated = true;
  }
  return files;
}

/** `./a/b` → `a/b`, and `/`-separated on Windows too. */
function normalize(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}

/**
 * One match line, with rg's UTF-8 byte offsets turned into UTF-16 offsets
 * for the page, and a long line cut to a window around its first match.
 */
function toLine(
  raw: string,
  line: number,
  submatches: { start: number; end: number }[],
): MatchLine {
  const text = raw.replace(/\r?\n$/, "");
  const bytes = Buffer.from(text, "utf8");
  // An ASCII line's byte offsets are its UTF-16 offsets. Otherwise rg's
  // offsets, which ascend, are converted in one pass: re-decoding from the
  // start for each one is quadratic on a long minified line.
  let ranges: [number, number][];
  if (bytes.length === text.length)
    ranges = submatches.map((match): [number, number] => [
      match.start,
      match.end,
    ]);
  else {
    let byteAt = 0;
    let charAt = 0;
    const offset = (byte: number) => {
      const to = Math.min(Math.max(byte, byteAt), bytes.length);
      charAt += bytes.subarray(byteAt, to).toString("utf8").length;
      byteAt = to;
      return charAt;
    };
    ranges = submatches.map((match): [number, number] => [
      offset(match.start),
      offset(match.end),
    ]);
  }
  if (text.length <= LINE_MAX) return { line, text, ranges };
  let from = Math.max(0, (ranges[0]?.[0] ?? 0) - LINE_LEAD);
  let to = Math.min(text.length, from + LINE_MAX);
  // Never cut a surrogate pair in half.
  if (isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (isLowSurrogate(text.charCodeAt(to))) to -= 1;
  ranges = ranges
    .filter(([start]) => start >= from && start < to)
    .map(([start, end]): [number, number] => [
      start - from,
      Math.min(end, to) - from,
    ]);
  return { line, text: text.slice(from, to), ranges };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
