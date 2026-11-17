// Search across the agents' session transcripts (FE-149): Claude Code's and
// Codex's JSONL files through the bundled ripgrep, OpenCode's database
// through SQL. The Sessions search (⌘K on the rail) and the offline MCP's
// `search_sessions` both call `searchSessions`.
//
// NOTE: Nothing here imports Electron at the top: the offline MCP server,
// run under ELECTRON_RUN_AS_NODE, bundles this file. `registerSessionSearch`
// loads Electron, the IPC gate and the project folders only when main calls
// it, so esbuild drops all three from the MCP's bundle (the bundle-boundary
// gate, `scripts/audit-electron.mjs`, checks it).
//
// Read-only: the CLIs' own files are opened for reading and never written.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { ConversationAgent } from "../../../shared/conversation";
import {
  fsSearchChannels,
  type MatchLine,
  type SearchSessionsOptions,
  type SessionMatch,
} from "../../../shared/fs-search";
import { isAgentSessionId } from "../../../shared/terminal";
import { claudeDir, codexHome, readText } from "../agent-home";
import { FsSearchTimeoutError, runRg } from "../fs-kit";
import {
  claudeImagePrompt,
  claudePrompt,
  codexPrompt,
  codexRole,
} from "../terminal/agent-sessions";
import {
  opencodeDataDirOf,
  opencodePromptText,
  opencodeTitle,
  withOpencodeDb,
} from "../terminal/opencode-sessions";
import {
  CHUNK,
  claudeProjectDir,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "./jsonl";

/** Sessions returned when the caller names no limit. */
export const SESSION_LIMIT = 20;
/** The most sessions one search returns, whatever the caller asks. */
export const SESSION_LIMIT_MAX = 50;
/** Matching lines kept per session. */
const LINES_PER_SESSION = 3;
/**
 * Matching lines rg hands over per transcript.
 *
 * More than are kept: a line that matched only on its metadata (the `cwd`
 * every Claude line carries, Codex's system prompt) is dropped after.
 */
const RG_MAX_COUNT = 40;
/**
 * The first batch's size in bytes; each next batch is twice the last.
 *
 * NOTE: The transcripts are gigabytes. Searched newest first in growing
 * batches, a query with a recent hit answers after the first batch (about
 * 100 ms of rg) instead of after the whole history (over a second).
 */
const FIRST_BATCH_BYTES = 128 * 1024 * 1024;
/** A snippet's length around its match, in characters. */
const SNIPPET_MAX = 200;
/** How much of a snippet comes before its match. */
const SNIPPET_LEAD = 60;
/**
 * How far into a Claude transcript its title is looked for when the head
 * holds none: a first prompt with an image pasted in is that long.
 */
const OPENING_MAX = 4 * 1024 * 1024;
/** Rows read per OpenCode session, at most: a few more than are kept. */
const OPENCODE_ROWS = 12;

export interface SearchSessionsRunOptions
  extends Omit<SearchSessionsOptions, "project"> {
  /** Sessions returned, newest first: {@link SESSION_LIMIT} unset, at most {@link SESSION_LIMIT_MAX}. */
  limit?: number;
  /**
   * Only sessions run in one of these folders (absolute paths); every
   * folder's when unset. An empty list finds nothing.
   */
  folders?: string[];
  /** The whole search, in milliseconds; 10 s when unset. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The home folder the CLIs' stores are under; the user's own when unset. */
  home?: string;
}

/** One transcript file that may be searched. */
interface Candidate {
  harness: "claude" | "codex";
  path: string;
  mtimeMs: number;
  size: number;
}

/** Finds the query in a piece of text, the way rg was asked to. */
type Finder = (text: string) => RegExp;

/**
 * Search the agents' transcripts for `query`, newest session first.
 *
 * - Claude Code: `<claude dir>/projects/<folder>/<id>.jsonl`. A sub-agent's
 *   own transcript (`<id>/subagents/`) is not searched: what it was asked and
 *   what it answered are in its parent's transcript already.
 * - Codex: `<codex home>/sessions/YYYY/MM/DD/rollout-….jsonl`. A thread a
 *   conversation spawned counts as that conversation; Codex's own helpers
 *   (approval reviews) are skipped.
 * - OpenCode: its `opencode.db`, both schemas; a sub-agent's session counts
 *   as its parent's.
 *
 * Only what was said is matched: prompts, answers, tool calls and their
 * output. A line that matched only on its metadata (a path, an id, the
 * system prompt) is not a match.
 *
 * NOTE: Newest transcripts first, in batches that double; the search stops
 * after the batch that brought `limit` sessions. So a common word answers
 * fast, and a rare one costs a read of the whole history.
 *
 * @throws {FsSearchTimeoutError} When the time ran out before any match.
 * @throws {RipgrepMissingError} When `rg` is missing.
 * @throws The signal's reason when aborted.
 */
export async function searchSessions(
  query: string,
  options: SearchSessionsRunOptions = {},
): Promise<SessionMatch[]> {
  if (!query.trim()) return [];
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? SESSION_LIMIT)),
    SESSION_LIMIT_MAX,
  );
  const harnesses = new Set<ConversationAgent>(
    options.harnesses ?? ["claude", "codex", "opencode"],
  );
  const home = options.home ?? homedir();
  const folders = options.folders ? new Set(options.folders) : null;
  const finder = makeFinder(query, options);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const found = new Map<string, SessionMatch>();
  const keep = (match: SessionMatch) => {
    const key = `${match.harness}:${match.sessionId}`;
    const had = found.get(key);
    if (!had) return void found.set(key, match);
    // Two files of one session (a Codex thread and its conversation).
    for (const line of match.lines)
      if (had.lines.length < LINES_PER_SESSION) had.lines.push(line);
    if (match.at > had.at) had.at = match.at;
  };

  // OpenCode's search is SQL, and synchronous: started once the first rg is
  // running, so the two read at once.
  let opencode: Promise<SessionMatch[]> | null = null;
  const startOpencode = () => {
    opencode ??= harnesses.has("opencode")
      ? searchOpencode(home, query, finder, options, folders, limit, deadline)
      : Promise.resolve([]);
    return opencode;
  };
  const candidates = (
    await Promise.all([
      harnesses.has("claude")
        ? claudeCandidates(home, folders)
        : Promise.resolve([]),
      harnesses.has("codex")
        ? codexCandidates(home, folders, options.signal)
        : Promise.resolve([]),
    ])
  )
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let timedOut = false;
  let budget = FIRST_BATCH_BYTES;
  let at = 0;
  while (at < candidates.length && found.size < limit) {
    const batch: Candidate[] = [];
    let bytes = 0;
    while (at < candidates.length && (batch.length === 0 || bytes < budget)) {
      const next = candidates[at++] as Candidate;
      batch.push(next);
      bytes += next.size;
    }
    budget *= 2;
    const left = deadline - Date.now();
    if (left <= 0) {
      timedOut = true;
      break;
    }
    const searching = searchFiles(batch, query, finder, options, left);
    startOpencode();
    const hits = await searching;
    timedOut = hits.timedOut;
    const matches = await Promise.all(
      batch
        .filter((file) => hits.lines.has(file.path))
        .map((file) =>
          describe(file, hits.lines.get(file.path) ?? [], home, folders),
        ),
    );
    for (const match of matches) if (match) keep(match);
    if (timedOut) break;
  }
  for (const match of await startOpencode()) keep(match);

  const out = [...found.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
  if (timedOut && out.length === 0)
    throw new FsSearchTimeoutError("The search took too long.");
  return out;
}

// ── Which files ─────────────────────────────────────────────────────────────

async function statCandidate(
  harness: Candidate["harness"],
  path: string,
): Promise<Candidate | null> {
  const info = await stat(path).catch(() => null);
  return info?.isFile()
    ? { harness, path, mtimeMs: info.mtimeMs, size: info.size }
    : null;
}

/** Claude's transcripts: every project folder's, or `folders`' only. */
async function claudeCandidates(
  home: string,
  folders: Set<string> | null,
): Promise<Candidate[]> {
  const root = join(claudeDir(home), "projects");
  const dirs = folders
    ? [...new Set([...folders].map(claudeProjectDir))]
    : await readdir(root).catch(() => [] as string[]);
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const names = await readdir(join(root, dir)).catch(() => [] as string[]);
      return Promise.all(
        names
          .filter((name) => isAgentSessionId(name.replace(/\.jsonl$/, "")))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => statCandidate("claude", join(root, dir, name))),
      );
    }),
  );
  return found.flat().filter((file) => file !== null);
}

/**
 * Codex's rollouts: all of them, or those whose `session_meta` names one of
 * `folders` (Codex keeps every folder's in one tree).
 */
async function codexCandidates(
  home: string,
  folders: Set<string> | null,
  signal: AbortSignal | undefined,
): Promise<Candidate[]> {
  const files: string[] = [];
  const down = async (dir: string, depth: number): Promise<void> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        if (depth < 3) return down(join(dir, name), depth + 1);
        if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
          files.push(join(dir, name));
      }),
    );
  };
  await down(join(codexHome(home), "sessions"), 0);
  const stated = (
    await Promise.all(files.map((file) => statCandidate("codex", file)))
  ).filter((file) => file !== null);
  if (!folders) return stated;
  signal?.throwIfAborted();
  const metas = await Promise.all(stated.map((file) => codexMeta(file.path)));
  return stated.filter((_, index) => {
    const cwd = metas[index]?.cwd;
    return typeof cwd === "string" && folders.has(cwd);
  });
}

/** A rollout's `session_meta` payload, read once per file. */
const codexMetas = new Map<string, Record<string, unknown> | null>();

async function codexMeta(
  file: string,
): Promise<Record<string, unknown> | null> {
  if (codexMetas.has(file)) return codexMetas.get(file) ?? null;
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true,
  });
  const meta =
    (head.find((line) => line.type === "session_meta")?.payload as
      | Record<string, unknown>
      | undefined) ?? null;
  // NOTE: Not cached until written: a rollout being created has none yet.
  if (meta) codexMetas.set(file, meta);
  return meta;
}

// ── rg ──────────────────────────────────────────────────────────────────────

/**
 * The front of an rg `match` event, up to its path. A path rg sent as bytes
 * (not UTF-8) does not match, and is passed over.
 */
const MATCH_HEAD =
  /^\{"type":"match","data":\{"path":\{"text":"((?:[^"\\]|\\.)*)"\}/;
/**
 * The longest rg event parsed, in characters. A longer line is a file's
 * contents or an image, and is passed over.
 */
const LINE_PARSE_MAX = 2 * 1024 * 1024;
/**
 * The line types that hold what was said, as they read inside rg's event
 * (the line is a JSON string there, its quotes escaped). A line with none of
 * them (Claude's attachments and API request blobs, Codex's `turn_context`)
 * is passed over unparsed: most of what a common word matches is those.
 */
const SPOKEN_TYPES: Record<Candidate["harness"], string[]> = {
  claude: ['\\"type\\":\\"user\\"', '\\"type\\":\\"assistant\\"'],
  codex: ['\\"type\\":\\"response_item\\"', '\\"type\\":\\"event_msg\\"'],
};

interface RgMatchEvent {
  data: {
    lines?: { text?: string };
    line_number?: number | null;
  };
}

/**
 * rg over `batch`, each file's matching lines turned into snippets of what
 * was said. A line that is not JSON or matched only outside what was said
 * is dropped.
 */
async function searchFiles(
  batch: Candidate[],
  query: string,
  finder: Finder,
  options: SearchSessionsRunOptions,
  timeoutMs: number,
): Promise<{ lines: Map<string, MatchLine[]>; timedOut: boolean }> {
  const out = new Map<string, MatchLine[]>();
  const harness = new Map(batch.map((file) => [file.path, file.harness]));
  const args = [
    "--json",
    options.regex ? "--no-fixed-strings" : "--fixed-strings",
    options.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--max-count",
    String(RG_MAX_COUNT),
    "--no-messages",
    // `-e` keeps a query starting with `-` a query.
    "--regexp",
    query,
    "--",
    ...batch.map((file) => file.path),
  ];
  const result = await runRg(args, {
    cwd: batch[0] ? join(batch[0].path, "..") : homedir(),
    timeoutMs,
    signal: options.signal,
    onLine: (raw) => {
      // A transcript line can be megabytes (a file read, an image), and
      // parsing it twice is what a search spends its time on. So the path
      // is read off the front first, and a line of a file that has its
      // snippets already, or a line past the cap, is passed over unparsed.
      const head = MATCH_HEAD.exec(raw);
      if (!head || raw.length > LINE_PARSE_MAX) return undefined;
      let path: string;
      try {
        path = JSON.parse(`"${head[1]}"`) as string;
      } catch {
        return undefined;
      }
      const kind = harness.get(path);
      const kept = out.get(path) ?? [];
      if (!kind || kept.length >= LINES_PER_SESSION) return undefined;
      if (!SPOKEN_TYPES[kind].some((type) => raw.includes(type)))
        return undefined;
      let event: RgMatchEvent;
      try {
        event = JSON.parse(raw) as RgMatchEvent;
      } catch {
        return undefined;
      }
      const text = event.data.lines?.text;
      if (text === undefined) return undefined;
      const snippet = snippetOf(
        kind,
        text,
        event.data.line_number ?? 0,
        finder,
      );
      if (!snippet || kept.some((line) => line.text === snippet.text))
        return undefined;
      kept.push(snippet);
      out.set(path, kept);
      return undefined;
    },
  });
  return { lines: out, timedOut: result.timedOut };
}

// ── What was said, and the snippet ──────────────────────────────────────────

/** Keys whose values are ids, types, signatures or base64, never words. */
const NOT_SAID = new Set([
  "id",
  "type",
  "uuid",
  "parentUuid",
  "tool_use_id",
  "call_id",
  "signature",
  "data",
  "encrypted_content",
  "media_type",
  "model",
  "cwd",
  "providerID",
]);

/**
 * Context a CLI put in a turn for itself (`<system-reminder>`, Codex's
 * `<environment_context>`, AGENTS.md), not what was said.
 */
const INJECTED = /^(<[a-z][\w-]*[\s>]|# AGENTS\.md)/;

/** Every string under `value`, but ids, types and base64. */
function said(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 200) return;
  if (typeof value === "string") {
    if (!INJECTED.test(value.trimStart())) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) said(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (!NOT_SAID.has(key)) said(item, out, depth + 1);
}

/** The part of a transcript line that holds what was said, if any. */
function spoken(harness: Candidate["harness"], line: Line): unknown {
  if (harness === "claude") {
    if (line.type !== "user" && line.type !== "assistant") return undefined;
    if (line.isMeta) return undefined;
    return (line.message as { content?: unknown } | undefined)?.content;
  }
  // Codex: `session_meta` (the system prompt) and `turn_context` are not.
  if (line.type !== "response_item" && line.type !== "event_msg")
    return undefined;
  return line.payload;
}

/**
 * A matching transcript line as a snippet: the text around the first match
 * in what was said, whitespace collapsed, with its matches marked.
 *
 * @returns null when the line matched only outside what was said.
 */
function snippetOf(
  harness: Candidate["harness"],
  raw: string,
  line: number,
  finder: Finder,
): MatchLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const texts: string[] = [];
  said(spoken(harness, parsed as Line), texts);
  return snippetFrom(texts, line, finder);
}

/** {@link snippetOf} for strings already picked out. */
function snippetFrom(
  texts: string[],
  line: number,
  finder: Finder,
): MatchLine | null {
  for (const text of texts) {
    const pattern = finder(text);
    const first = pattern.exec(text);
    if (!first) continue;
    const start = first.index;
    const end = start + first[0].length;
    // A window of the raw text around the match, then tidied: collapsing
    // whitespace in a megabyte of tool output only to cut it is waste.
    const from = Math.max(0, start - SNIPPET_LEAD * 2);
    const to = Math.min(text.length, end + SNIPPET_MAX * 2);
    let window = text.slice(from, to).replace(/\s+/g, " ");
    const lead = window.search(finder(window));
    if (lead === -1) continue;
    const cut = Math.max(0, lead - SNIPPET_LEAD);
    window = window.slice(cut, cut + SNIPPET_MAX);
    const before = from > 0 || cut > 0 ? "…" : "";
    const after = to < text.length || window.length >= SNIPPET_MAX ? "…" : "";
    const body = `${before}${window.trim()}${after}`;
    const ranges: [number, number][] = [];
    const marks = finder(body);
    for (const match of body.matchAll(
      new RegExp(marks.source, `${marks.flags}g`),
    )) {
      if (!match[0]) break;
      ranges.push([match.index, match.index + match[0].length]);
    }
    if (ranges.length === 0) continue;
    return { line, text: body, ranges };
  }
  return null;
}

/** The query as a JavaScript pattern, matched as rg was asked to. */
function makeFinder(
  query: string,
  options: Pick<SearchSessionsRunOptions, "regex" | "caseSensitive">,
): Finder {
  const flags = options.caseSensitive ? "u" : "iu";
  let source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.regex) {
    try {
      new RegExp(query, flags);
      source = query;
    } catch {
      // rg's syntax that JavaScript's lacks: matched as a literal here.
    }
  }
  return () => new RegExp(source, flags);
}

// ── Which session, its title and date ───────────────────────────────────────

/** A transcript's title, read once per version of the file. */
const titles = new Map<string, { mtimeMs: number; value: Described | null }>();

interface Described {
  sessionId: string;
  title: string;
  cwd: string | null;
}

/** A transcript file with matches, as a session; null if it is not one. */
async function describe(
  file: Candidate,
  matched: MatchLine[],
  home: string,
  folders: Set<string> | null,
): Promise<SessionMatch | null> {
  const cached = titles.get(file.path);
  let value: Described | null;
  if (cached && cached.mtimeMs === file.mtimeMs) value = cached.value;
  else {
    value = await (file.harness === "claude"
      ? claudeDescribed(file)
      : codexDescribed(file, home)
    ).catch(() => null);
    titles.set(file.path, { mtimeMs: file.mtimeMs, value });
  }
  if (!value) return null;
  // NOTE: Claude's folder name is lossy (`a_b` and `a-b` both become
  // `a-b`), so the transcript's own `cwd` has the last word.
  if (folders && value.cwd !== null && !folders.has(value.cwd)) return null;
  const root = file.harness === "claude" ? claudeDir(home) : codexHome(home);
  return {
    harness: file.harness,
    sessionId: value.sessionId,
    title: value.title,
    at: new Date(file.mtimeMs).toISOString(),
    file: relative(root, file.path).split(sep).join("/"),
    lines: matched,
  };
}

/**
 * A Claude transcript's id, title and folder, the way the rail names it
 * (`agent-sessions.ts`): its latest `ai-title`, else its first prompt.
 */
async function claudeDescribed(file: Candidate): Promise<Described | null> {
  const head = lines(await readRange(file.path, 0, CHUNK), { head: true });
  const tail =
    file.size > CHUNK
      ? lines(await readRange(file.path, file.size - CHUNK, CHUNK), {
          head: false,
        })
      : head;
  const named = [...tail, ...head]
    .reverse()
    .find(
      (line) => line.type === "ai-title" && typeof line.aiTitle === "string",
    )?.aiTitle as string | undefined;
  const cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
  let title = named ? tidy(named) : head.map(claudePrompt).find(Boolean);
  // A first prompt longer than the head (an image or a long paste in it):
  // read further, as the rail does.
  if (!title) {
    const opening = lines(await readRange(file.path, 0, OPENING_MAX), {
      head: true,
    });
    title =
      opening.map(claudePrompt).find(Boolean) ??
      opening.map(claudeImagePrompt).find(Boolean);
  }
  return {
    sessionId: basename(file.path, ".jsonl"),
    title: title ?? "Untitled conversation",
    cwd: typeof cwd === "string" ? cwd : null,
  };
}

/** Codex's thread names, read once per version of its index. */
let codexNamesRead: {
  file: string;
  mtimeMs: number;
  names: Map<string, string>;
} | null = null;

/** Codex's thread names, by id: `session_index.jsonl`, the last one wins. */
async function codexIndex(home: string): Promise<Map<string, string>> {
  const file = join(codexHome(home), "session_index.jsonl");
  const mtimeMs = (await stat(file).catch(() => null))?.mtimeMs ?? 0;
  if (codexNamesRead?.file === file && codexNamesRead.mtimeMs === mtimeMs)
    return codexNamesRead.names;
  const names = new Map<string, string>();
  const text = (await readText(file, 16 * 1024 * 1024)) ?? "";
  for (const line of lines(`${text}\n`, { head: true }))
    if (typeof line.id === "string" && typeof line.thread_name === "string")
      names.set(line.id, line.thread_name);
  codexNamesRead = { file, mtimeMs, names };
  return names;
}

/**
 * A Codex rollout's conversation, title and folder.
 *
 * A thread a conversation spawned is that conversation; Codex's own helper
 * is none (`codexRole`).
 */
async function codexDescribed(
  file: Candidate,
  home: string,
): Promise<Described | null> {
  const meta = await codexMeta(file.path);
  if (!meta || !isAgentSessionId(meta.id)) return null;
  const role = codexRole(meta);
  if (role.kind === "helper") return null;
  const sessionId = role.kind === "spawned" ? role.root : meta.id;
  const named = (await codexIndex(home)).get(sessionId);
  let title = named ? tidy(named) : null;
  if (!title && role.kind === "conversation") {
    const head = lines(await readRange(file.path, 0, META_CHUNK), {
      head: true,
    });
    title = head.map(codexPrompt).find(Boolean) ?? null;
  }
  return {
    sessionId,
    title: title ?? "Codex conversation",
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
  };
}

// ── OpenCode ────────────────────────────────────────────────────────────────

/** A session of OpenCode's, as the search walks them. */
interface OpencodeSessionRow {
  id: unknown;
  parent: unknown;
  title: unknown;
  updated: unknown;
}

/**
 * OpenCode's sessions that said `query`, from its database: `session_v2`'s
 * messages and the older `session`'s parts, whichever it has.
 *
 * NOTE: Sessions are walked newest first, each one's rows read through its
 * `session_id` index, until `limit` sessions said it. One query over every
 * row, sorted by session, took seconds on a 300 MB database for a common
 * word: it matched, and sorted, every row. The read is synchronous
 * (`node:sqlite`), so it stops at `deadline` too.
 */
async function searchOpencode(
  home: string,
  query: string,
  finder: Finder,
  options: SearchSessionsRunOptions,
  folders: Set<string> | null,
  limit: number,
  deadline: number,
): Promise<SessionMatch[]> {
  if (folders?.size === 0) return [];
  return withOpencodeDb(opencodeDataDirOf(home), [], (db) => {
    let test: string;
    let bound: string;
    if (options.regex) {
      const pattern = finder("");
      db.function("lw_matches", { deterministic: true }, (value) =>
        typeof value === "string" && pattern.test(value) ? 1 : 0,
      );
      test = "lw_matches(data) = 1 AND ?2 IS NOT NULL";
      bound = query;
    } else if (options.caseSensitive) {
      test = "instr(data, ?2) > 0";
      bound = query;
    } else {
      // LIKE ignores the case of ASCII letters only; the snippet's own
      // match, below, is what decides.
      test = "data LIKE ?2 ESCAPE '\\'";
      bound = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    }
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    // The folders, as a JSON list SQL reads with `json_each`; null for all.
    const scope = folders ? JSON.stringify([...folders]) : null;
    const sources: {
      table: "session_v2" | "session";
      rows: import("node:sqlite").StatementSync;
    }[] = [];
    if (tables.has("session_v2") && tables.has("session_message"))
      sources.push({
        table: "session_v2",
        rows: db.prepare(
          `SELECT seq, data FROM session_message
            WHERE session_id = ?1 AND type IN ('user', 'assistant')
              AND ${test}
            ORDER BY seq LIMIT ${OPENCODE_ROWS}`,
        ),
      });
    if (tables.has("session") && tables.has("part"))
      sources.push({
        table: "session",
        rows: db.prepare(
          `SELECT 0 AS seq, data FROM part
            WHERE session_id = ?1 AND ${test}
            ORDER BY time_created LIMIT ${OPENCODE_ROWS}`,
        ),
      });
    const sessions = sources.flatMap(({ table, rows }) =>
      (
        db
          .prepare(
            `SELECT id, parent_id AS parent, title, time_updated AS updated
               FROM ${table}
              WHERE ?1 IS NULL OR directory IN (SELECT value FROM json_each(?1))`,
          )
          .all(scope) as unknown as OpencodeSessionRow[]
      ).map((session) => ({ ...session, table, rows })),
    );
    sessions.sort(
      (a, b) =>
        (typeof b.updated === "number" ? b.updated : 0) -
        (typeof a.updated === "number" ? a.updated : 0),
    );

    const out = new Map<string, SessionMatch>();
    for (const session of sessions) {
      if (out.size >= limit || Date.now() > deadline) break;
      if (typeof session.id !== "string") continue;
      // A sub-agent's session counts as its parent's.
      const sessionId =
        typeof session.parent === "string" ? session.parent : session.id;
      const found = out.get(sessionId);
      if (found && found.lines.length >= LINES_PER_SESSION) continue;
      const kept: MatchLine[] = found?.lines ?? [];
      for (const row of session.rows.all(session.id, bound) as {
        seq?: unknown;
        data?: unknown;
      }[]) {
        if (kept.length >= LINES_PER_SESSION) break;
        let data: unknown;
        try {
          data = JSON.parse(String(row.data));
        } catch {
          continue;
        }
        const texts: string[] = [];
        said(data, texts);
        const seq = typeof row.seq === "number" ? row.seq : 0;
        const snippet = snippetFrom(texts, seq, finder);
        if (snippet && !kept.some((line) => line.text === snippet.text))
          kept.push(snippet);
      }
      if (found || kept.length === 0) continue;
      const updated = typeof session.updated === "number" ? session.updated : 0;
      out.set(sessionId, {
        harness: "opencode",
        sessionId,
        title:
          opencodeSessionTitle(db, session.table, sessionId) ??
          "OpenCode session",
        at: new Date(updated).toISOString(),
        file: "opencode.db",
        lines: kept,
      });
    }
    return [...out.values()];
  });
}

/** What the rail calls an OpenCode session: its title, else its first prompt. */
function opencodeSessionTitle(
  db: import("node:sqlite").DatabaseSync,
  table: "session_v2" | "session",
  id: string,
): string | null {
  const row = db.prepare(`SELECT title FROM ${table} WHERE id = ?`).get(id) as
    | { title?: unknown }
    | undefined;
  const named = opencodeTitle(row?.title);
  if (named || table !== "session_v2") return named;
  const first = db
    .prepare(
      `SELECT data FROM session_message
        WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1`,
    )
    .get(id) as { data?: unknown } | undefined;
  const prompt = opencodePromptText(first?.data);
  return prompt ? tidy(prompt) : null;
}

// ── IPC ─────────────────────────────────────────────────────────────────────

/** The longest query the page may send. */
const QUERY_MAX = 500;

/**
 * `fsSearch:sessions`: the page's Sessions search, from the trusted window
 * only. A window's new query aborts its last one.
 *
 * NOTE: Electron, the IPC gate and the project store are imported here, not
 * at the top, so the offline MCP's bundle never takes them. The handler is
 * registered a tick after main asks, long before a person can search.
 */
export function registerSessionSearch(devUrl: string | undefined): void {
  void Promise.all([
    import("electron"),
    import("../ipc"),
    import("../projects/session"),
  ]).then(([{ ipcMain }, { assertTrustedSender }, { projectFolders }]) => {
    const running = new Map<number, AbortController>();
    ipcMain.handle(
      fsSearchChannels.sessions,
      async (event, query: unknown, opts: unknown) => {
        if (!assertTrustedSender(event, devUrl)) return undefined;
        if (typeof query !== "string" || query.length > QUERY_MAX)
          throw new Error("The search query is not valid.");
        const asked = (
          opts && typeof opts === "object" ? opts : {}
        ) as SearchSessionsOptions;
        const sender = event.sender.id;
        running.get(sender)?.abort();
        const controller = new AbortController();
        running.set(sender, controller);
        try {
          // The project's folders are resolved here, never taken from the
          // page.
          const folders =
            typeof asked.project === "string" && asked.project
              ? await projectFolders(asked.project).catch(() => [])
              : undefined;
          return await searchSessions(query, {
            folders,
            harnesses: Array.isArray(asked.harnesses)
              ? asked.harnesses.filter(
                  (harness): harness is ConversationAgent =>
                    harness === "claude" ||
                    harness === "codex" ||
                    harness === "opencode",
                )
              : undefined,
            regex: asked.regex === true,
            caseSensitive: asked.caseSensitive === true,
            signal: controller.signal,
          });
        } catch (error) {
          // A query typed over is no answer anybody waits for.
          if (controller.signal.aborted) return [];
          throw error;
        } finally {
          if (running.get(sender) === controller) running.delete(sender);
        }
      },
    );
  });
}
