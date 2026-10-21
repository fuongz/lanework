// The files an agent conversation edited, read from its transcripts (FE-39):
// what the agent view's Files list shows, and the marks on Changes.
//
// ⚠️ Only what the CLIs' own FILE TOOLS did — Claude's `Edit`, `Write`,
// `MultiEdit` and `NotebookEdit` (and its file history, when that is on),
// Codex's `apply_patch`. A file changed through the shell is in no
// transcript, and the UI says so rather than let "not listed" read as "not
// touched".
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake home folder.
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentFileMarks,
  type AgentFileOp,
  type AgentFiles,
  type AgentFileTouch,
  type AgentSession,
  isAgentSessionId,
  type TerminalAgent,
} from "../../../shared/terminal";
import { locate, repoFacts } from "../git/worktree";
import {
  CLAUDE_SUBAGENT_FILE,
  claudeProjectDir,
  codexRole,
  codexRollouts,
  type Line,
  lines,
  META_CHUNK,
  readRange,
} from "./agent-sessions";

/**
 * The most of one transcript a scan reads (FE-39): its LAST 32 MB.
 *
 * ⚠️ The end, not the start. A long conversation's newest edits are the ones
 * still uncommitted — the ones Changes marks — and a scan that stopped at the
 * first 32 MB would never see a line written after it.
 */
export const AGENT_FILES_READ_MAX = 32 * 1024 * 1024;

/** What the agent view asks for, checked. */
interface AgentFilesRequest {
  workspace: string;
  agent: TerminalAgent;
  id: string;
}

/**
 * The agent view's request off the wire: ids, never a path (FE-39) — the
 * same rule as a sub-agent's (FE-35/D10). A conversation is a UUID, so it
 * can be no `..`, separator or absolute path.
 */
export function agentFilesRequest(args: unknown[]): AgentFilesRequest {
  if (args.length !== 3)
    throw new Error("A workspace, an agent and a conversation are required");
  const [workspace, agent, id] = args;
  if (
    typeof workspace !== "string" ||
    !workspace.trim() ||
    workspace.length > 200
  )
    throw new Error("A valid workspace is required");
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  return { workspace, agent, id };
}

/** Claude's file tools: each call edits the file its input names. */
const CLAUDE_EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * What a line must contain to be worth parsing — most of a transcript is
 * prompts, answers and tool output, and `JSON.parse` on every line of 32 MB
 * is most of the cost.
 *
 * ⚠️ Claude: a call to a file tool; its file history's delta; a failed result
 * (which takes the call back); a `Write` that created its file. Codex: a
 * `FileChange` item, or an `apply_patch` call — unquoted, because an older
 * CLI ran it through `shell` inside an escaped JSON string.
 */
const NEEDLES: Record<TerminalAgent, Buffer[]> = {
  claude: [
    '"file-history-delta"',
    ...[...CLAUDE_EDITS].map((name) => `"name":"${name}"`),
    '"is_error":true',
    '"type":"create"',
  ].map((needle) => Buffer.from(needle)),
  codex: ['"FileChange"', "apply_patch"].map((needle) => Buffer.from(needle)),
};

/** One file's edits in one transcript. */
interface Tally {
  /**
   * Edits counted from each of the two places a CLI records one: Claude's
   * tool calls and its file history; Codex's `FileChange` items and its
   * `apply_patch` calls. The larger is the count — one edit is often in both.
   */
  n: [number, number];
  lastAt: string;
  /** Created in this transcript: still "added" after a later edit. */
  added: boolean;
  /** What its newest edit did. */
  last: AgentFileOp;
}

/** What a transcript has said so far, kept to read only what it adds. */
interface Scan {
  size: number;
  mtimeMs: number;
  /** Where the whole lines read end: the next read starts here. */
  end: number;
  partial: boolean;
  /** By absolute path. */
  tallies: Map<string, Tally>;
  /** Claude's recent file-tool calls by id, for a failed result to take back. */
  pending: Map<string, string>;
}

/** Calls kept for a failed result to find; a result follows its call closely. */
const PENDING_MAX = 256;
/** Transcripts kept scanned; the oldest read is dropped first. */
const SCAN_CACHE = 256;
const scans = new Map<string, Scan>();
/** One scan of a transcript at a time: the next waits, then reads the tail. */
const running = new Map<string, Promise<unknown>>();

function tally(
  scan: Scan,
  path: string,
  source: 0 | 1,
  at: string,
  op: AgentFileOp,
): void {
  let found = scan.tallies.get(path);
  if (!found) {
    found = { n: [0, 0], lastAt: at, added: false, last: op };
    scan.tallies.set(path, found);
  }
  found.n[source]++;
  if (at >= found.lastAt) {
    found.lastAt = at;
    found.last = op;
  }
  if (op === "added") found.added = true;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/** One Claude line, if it records an edit. */
function claudeLine(line: Line, scan: Scan, folder: string, at: string): void {
  if (line.type === "file-history-delta") {
    // ⚠️ `trackingPath` is relative to where the session STARTED, which a
    // `cd` does not move; `realParentDir` is the file's own folder.
    const tracking = str(line.trackingPath);
    if (!tracking) return;
    const backup = line.backup as
      | { realParentDir?: unknown; backupFileName?: unknown }
      | undefined;
    const dir = str(backup?.realParentDir);
    tally(
      scan,
      dir ? join(dir, basename(tracking)) : resolve(folder, tracking),
      1,
      at,
      // No backup of the first version: there was no file to back up.
      backup?.backupFileName === null ? "added" : "modified",
    );
    return;
  }
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (line.type === "assistant" && Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type !== "tool_use" || !CLAUDE_EDITS.has(part.name as string))
        continue;
      const input = (part.input ?? {}) as Record<string, unknown>;
      const file = str(input.file_path) ?? str(input.notebook_path);
      if (!file) continue;
      const path = isAbsolute(file)
        ? file
        : resolve(str(line.cwd) ?? folder, file);
      tally(scan, path, 0, at, "modified");
      if (typeof part.id === "string") {
        scan.pending.set(part.id, path);
        if (scan.pending.size > PENDING_MAX)
          scan.pending.delete(scan.pending.keys().next().value as string);
      }
    }
    return;
  }
  if (line.type !== "user") return;
  if (Array.isArray(content))
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type !== "tool_result" || part.is_error !== true) continue;
      // A call that failed edited nothing.
      const path = scan.pending.get(part.tool_use_id as string);
      const found = path ? scan.tallies.get(path) : undefined;
      if (found && found.n[0] > 0) found.n[0]--;
    }
  const result = line.toolUseResult as
    | { type?: unknown; filePath?: unknown }
    | undefined;
  const created = result?.type === "create" ? str(result.filePath) : null;
  const found = created ? scan.tallies.get(created) : undefined;
  if (found) found.added = true;
}

const PATCH_HEADER =
  /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm;

/**
 * The files an `apply_patch` touches, by its `*** … File:` headers — a
 * `*** Move to:` renames the file the `Update File:` before it named.
 */
export function patchedFiles(
  patch: string,
): { path: string; op: AgentFileOp }[] {
  const out: { path: string; op: AgentFileOp }[] = [];
  for (const [, header, named] of patch.matchAll(PATCH_HEADER)) {
    const path = named?.trim();
    if (!path) continue;
    if (header === "Move to") {
      const moved = out.at(-1);
      if (moved?.op === "modified") {
        moved.path = path;
        moved.op = "renamed";
      }
    } else
      out.push({
        path,
        op:
          header === "Add File"
            ? "added"
            : header === "Delete File"
              ? "deleted"
              : "modified",
      });
  }
  return out;
}

/** The patch a Codex call applies, in each shape a CLI has written one. */
function codexPatch(payload: Record<string, unknown>): string | null {
  if (payload.type === "custom_tool_call" && payload.name === "apply_patch")
    return str(payload.input);
  if (payload.type !== "function_call" || typeof payload.arguments !== "string")
    return null;
  let args: { input?: unknown; command?: unknown };
  try {
    args = JSON.parse(payload.arguments) as typeof args;
  } catch {
    return null;
  }
  if (payload.name === "apply_patch") return str(args?.input);
  // Older CLIs: `shell` with `["apply_patch", "<patch>"]`.
  const command = args?.command;
  return Array.isArray(command) && command[0] === "apply_patch"
    ? str(command[1])
    : null;
}

/** One Codex line, if it records an edit. */
function codexLine(line: Line, scan: Scan, folder: string, at: string): void {
  const payload = line.payload as Record<string, unknown> | null | undefined;
  if (!payload) return;
  const where = (path: string) =>
    isAbsolute(path) ? path : resolve(folder, path);
  // ⚠️ What was APPLIED, by absolute path — whichever way the patch was
  // sent, a script's `tools.apply_patch(…)` included. A failed one is none.
  if (line.type === "event_msg" && payload.type === "item_completed") {
    const item = payload.item as Record<string, unknown> | undefined;
    if (item?.type !== "FileChange" || item.status !== "completed") return;
    const changes = item.changes;
    if (!changes || typeof changes !== "object") return;
    for (const [file, change] of Object.entries(
      changes as Record<string, { type?: unknown; move_path?: unknown }>,
    )) {
      if (change?.type === "add") tally(scan, where(file), 0, at, "added");
      else if (change?.type === "delete")
        tally(scan, where(file), 0, at, "deleted");
      else if (change?.type === "update") {
        const to = str(change.move_path);
        if (to) tally(scan, where(to), 0, at, "renamed");
        else tally(scan, where(file), 0, at, "modified");
      }
    }
    return;
  }
  if (line.type !== "response_item") return;
  const patch = codexPatch(payload);
  if (patch)
    for (const { path, op } of patchedFiles(patch))
      tally(scan, where(path), 1, at, op);
}

/** `[from, to)` of `file`, whole. */
async function readSpan(
  file: string,
  from: number,
  to: number,
): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        buffer.length - read,
        from + read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * The lines of `buffer` between `start` and `end` (a newline) that hold one
 * of `needles`, parsed, in the order they were written.
 *
 * ⚠️ Found by searching the BYTES for each needle, never by splitting every
 * line: a hit's line is cut out around it, and only those are decoded.
 */
function matchingLines(
  buffer: Buffer,
  start: number,
  end: number,
  needles: Buffer[],
): Line[] {
  const found = new Map<number, number>();
  for (const needle of needles) {
    let at = buffer.indexOf(needle, start);
    while (at !== -1 && at < end) {
      const from = buffer.lastIndexOf(0x0a, at) + 1;
      const to = buffer.indexOf(0x0a, at);
      const stop = to === -1 || to > end ? end : to;
      found.set(Math.max(from, start), stop);
      at = buffer.indexOf(needle, stop + 1);
    }
  }
  const out: Line[] = [];
  for (const from of [...found.keys()].sort((a, b) => a - b)) {
    try {
      const value: unknown = JSON.parse(
        buffer.toString("utf8", from, found.get(from)),
      );
      if (value && typeof value === "object") out.push(value as Line);
    } catch {
      // Cut, or not ours.
    }
  }
  return out;
}

async function scanOnce(
  file: string,
  agent: TerminalAgent,
  folder: string,
): Promise<Scan> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("No transcript.");
  const known = scans.get(file);
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs)
    return known;
  // ⚠️ A transcript only ever grows: one that grew is read from where the
  // last read's whole lines ended. One that shrank was replaced, and one
  // that grew past a whole read is read afresh — its newest part.
  const appended =
    known &&
    info.size >= known.size &&
    info.size - known.end <= AGENT_FILES_READ_MAX;
  const scan: Scan = appended
    ? known
    : {
        size: 0,
        mtimeMs: 0,
        end: 0,
        partial: false,
        tallies: new Map(),
        pending: new Map(),
      };
  const from = appended
    ? scan.end
    : Math.max(0, info.size - AGENT_FILES_READ_MAX);
  if (!appended) {
    scan.partial = from > 0;
    scan.end = from;
  }
  if (info.size > from) {
    const buffer = await readSpan(file, from, info.size);
    // A read that began mid-line: its first piece is not a line.
    const start = appended || from === 0 ? 0 : buffer.indexOf(0x0a) + 1;
    const last = buffer.lastIndexOf(0x0a);
    if (last >= start) {
      const fallback = info.mtime.toISOString();
      const read = agent === "claude" ? claudeLine : codexLine;
      for (const line of matchingLines(buffer, start, last, NEEDLES[agent]))
        read(
          line,
          scan,
          folder,
          typeof line.timestamp === "string" ? line.timestamp : fallback,
        );
      // ⚠️ A line still being written is left for the next read.
      scan.end = from + last + 1;
    }
  }
  scan.size = info.size;
  scan.mtimeMs = info.mtimeMs;
  scans.delete(file);
  scans.set(file, scan);
  while (scans.size > SCAN_CACHE)
    scans.delete(scans.keys().next().value as string);
  return scan;
}

/**
 * What `file` — one of `agent`'s transcripts — has edited, by absolute path;
 * cached by (path, size, mtime), so reading it again only parses what was
 * appended since (FE-39).
 */
export async function scanTranscript(
  file: string,
  agent: TerminalAgent,
  folder: string,
): Promise<{
  partial: boolean;
  files: Map<string, { op: AgentFileOp; edits: number; lastAt: string }>;
}> {
  const before = running.get(file) ?? Promise.resolve();
  const next = before
    .catch(() => undefined)
    .then(() => scanOnce(file, agent, folder));
  running.set(file, next);
  try {
    const scan = await next;
    const files = new Map<
      string,
      { op: AgentFileOp; edits: number; lastAt: string }
    >();
    for (const [path, found] of scan.tallies) {
      const edits = Math.max(found.n[0], found.n[1]);
      if (edits === 0) continue;
      files.set(path, {
        op:
          found.last === "deleted"
            ? "deleted"
            : found.added
              ? "added"
              : found.last,
        edits,
        lastAt: found.lastAt,
      });
    }
    return { partial: scan.partial, files };
  } finally {
    if (running.get(file) === next) running.delete(file);
  }
}

/** Where a conversation's paths are reckoned from. */
interface RepoRoots {
  /** The project's folder, as the CLIs were started in it. */
  folder: string;
  /** Its real path: what git and Claude's file history spell it as. */
  real: string;
  /** The repository's top level, or the folder's real path without one. */
  top: string;
  /** Other worktrees of the repository: a path in one is not this one's. */
  others: string[];
  /** When HEAD was committed, epoch ms; null with no commit or no repository. */
  headAt: number | null;
  repo: boolean;
}

/** `folder`'s repository, as the agent files are reckoned against it. */
async function repoRoots(folder: string): Promise<RepoRoots> {
  const real = await realpath(folder).catch(() => folder);
  const found = await locate(folder);
  if (found.kind !== "ready")
    return { folder, real, top: real, others: [], headAt: null, repo: false };
  const facts = await repoFacts(found.top).catch(() => ({
    headAt: null,
    worktrees: [] as string[],
  }));
  return {
    folder,
    real,
    top: found.top,
    others: facts.worktrees,
    headAt: facts.headAt,
    repo: true,
  };
}

/**
 * `path` from the repository's top, `/`-separated; null for one outside it
 * or inside another of its worktrees (a sub-agent's isolated checkout).
 */
function fromTop(path: string, roots: RepoRoots): string | null {
  // ⚠️ A CLI names files under the folder as it was started in it, git
  // under its real path: `/var/…` and `/private/var/…` are the same file.
  const real =
    path === roots.folder || path.startsWith(roots.folder + sep)
      ? roots.real + path.slice(roots.folder.length)
      : path;
  for (const other of roots.others)
    if (real === other || real.startsWith(other + sep)) return null;
  const inside = relative(roots.top, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

/** A transcript to read, and the sub-agent that wrote it (null: its own). */
interface Source {
  file: string;
  via: AgentFileTouch["via"];
}

/** Codex rollouts' `session_meta`, by file: written once, never changed. */
const codexMetas = new Map<string, Record<string, unknown> | null>();

async function codexMeta(
  file: string,
): Promise<Record<string, unknown> | null> {
  if (codexMetas.has(file)) return codexMetas.get(file) ?? null;
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true,
  });
  const meta = (head.find((line) => line.type === "session_meta")?.payload ??
    null) as Record<string, unknown> | null;
  // Not written yet is worth asking again; anything else is kept.
  if (meta) {
    codexMetas.set(file, meta);
    if (codexMetas.size > 1024)
      codexMetas.delete(codexMetas.keys().next().value as string);
  }
  return meta;
}

/**
 * Claude conversation `id`'s transcript and its sub-agents' (FE-33), each
 * with its `.meta.json`'s kind for "via" (FE-39/D5).
 */
async function claudeSources(
  home: string,
  folder: string,
  id: string,
): Promise<Source[]> {
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  const own = join(dir, `${id}.jsonl`);
  // ⚠️ The folder name is lossy — `a_b` and `a-b` both become `a-b` — so the
  // transcript's own `cwd` has the last word, as the listing's does.
  const head = lines(await readRange(own, 0, 64 * 1024).catch(() => ""), {
    head: true,
  });
  const cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
  if (head.length === 0 || (cwd !== undefined && cwd !== folder))
    throw new Error("That conversation is not one of this project's.");
  const subagents = join(dir, id, "subagents");
  const names = await readdir(subagents).catch(() => [] as string[]);
  const subs = await Promise.all(
    names.map(async (name): Promise<Source | null> => {
      const sub = CLAUDE_SUBAGENT_FILE.exec(name)?.[1];
      if (!sub) return null;
      const meta = (await readFile(
        join(subagents, `agent-${sub}.meta.json`),
        "utf8",
      )
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => null)) as { agentType?: unknown } | null;
      return {
        file: join(subagents, name),
        via: { id: sub, type: str(meta?.agentType) },
      };
    }),
  );
  return [{ file: own, via: null }, ...subs.filter((entry) => entry !== null)];
}

/**
 * Codex conversation `id`'s rollout, and those of the threads it spawned
 * (FE-33) — which start after it, so only newer rollouts are opened.
 */
async function codexSources(
  home: string,
  folder: string,
  id: string,
): Promise<Source[]> {
  const files = await codexRollouts(join(home, ".codex", "sessions"));
  const at = files.findIndex((file) => basename(file).endsWith(`-${id}.jsonl`));
  const own = at === -1 ? undefined : files[at];
  const meta = own ? await codexMeta(own) : null;
  if (
    !own ||
    meta?.id !== id ||
    meta.cwd !== folder ||
    codexRole(meta).kind !== "conversation"
  )
    throw new Error("That conversation is not one of this project's.");
  const out: Source[] = [{ file: own, via: null }];
  for (const file of files.slice(0, at)) {
    const spawned = await codexMeta(file);
    if (!spawned || spawned.cwd !== folder || !isAgentSessionId(spawned.id))
      continue;
    const role = codexRole(spawned);
    if (role.kind !== "spawned" || role.root !== id) continue;
    out.push({
      file,
      via: { id: spawned.id, type: role.role ?? role.nickname },
    });
  }
  return out;
}

/**
 * The files `agent`'s conversation `id` in `folder` edited with its file
 * tools — its sub-agents' folded in, each marked "via" its kind when the
 * conversation never edited it itself (FE-39/D5) — newest edit first.
 *
 * ⚠️ The id is checked again here, and every path is built from it inside
 * the CLI's own folder under `home`. Paths outside the repository, and in
 * another of its worktrees, are dropped.
 */
export async function readAgentFiles(
  home: string,
  folder: string,
  { agent, id }: Omit<AgentFilesRequest, "workspace">,
  known?: RepoRoots,
): Promise<AgentFiles> {
  agentFilesRequest(["-", agent, id]);
  const roots = known ?? (await repoRoots(folder));
  const sources =
    agent === "claude"
      ? await claudeSources(home, folder, id)
      : await codexSources(home, folder, id);
  const scanned = await Promise.all(
    sources.map(async (source) => ({
      source,
      scan: await scanTranscript(source.file, agent, folder).catch(() => null),
    })),
  );
  const merged = new Map<string, AgentFileTouch & { own: boolean }>();
  let partial = false;
  for (const { source, scan } of scanned) {
    if (!scan) continue;
    partial ||= scan.partial;
    for (const [absolute, found] of scan.files) {
      const path = fromTop(absolute, roots);
      if (!path) continue;
      const before = merged.get(path);
      if (!before) {
        merged.set(path, {
          path,
          ...found,
          via: source.via,
          own: source.via === null,
        });
        continue;
      }
      const newer = found.lastAt >= before.lastAt;
      before.edits += found.edits;
      before.own ||= source.via === null;
      if (newer) {
        before.lastAt = found.lastAt;
        // Created by one, edited by another: still a new file.
        before.op =
          before.op === "added" && found.op !== "deleted" ? "added" : found.op;
        if (!before.own) before.via = source.via;
      } else if (found.op === "added" && before.op !== "deleted")
        before.op = "added";
    }
  }
  const files = [...merged.values()]
    .map(({ own, ...touch }) => ({ ...touch, via: own ? null : touch.via }))
    .sort(
      (a, b) =>
        b.lastAt.localeCompare(a.lastAt) || a.path.localeCompare(b.path),
    );
  return { files, partial };
}

/**
 * When a conversation last moved, its sub-agents included: a sub-agent
 * running in the background writes after its conversation's last line.
 */
function lastMoved(session: AgentSession): number {
  return Math.max(
    Date.parse(session.updatedAt) || 0,
    ...session.subagents.map((sub) => Date.parse(sub.updatedAt) || 0),
  );
}

/**
 * Which of `sessions` — `folder`'s listing — edited each file since HEAD's
 * commit (FE-39/D2, D3), keyed by its path from the repository's top.
 *
 * ⚠️ Since the COMMIT, so a mark is uncommitted work: a conversation that
 * has not moved since is not read at all, and an edit older than the commit
 * is in it. The commit time has one-second resolution, so an edit in the
 * same second counts as committed.
 */
export async function agentFileMarks(
  home: string,
  folder: string,
  sessions: AgentSession[],
): Promise<AgentFileMarks> {
  const roots = await repoRoots(folder);
  if (!roots.repo) return { files: {}, partial: false };
  const since = roots.headAt ?? 0;
  const after = (iso: string) =>
    Math.floor((Date.parse(iso) || 0) / 1000) * 1000 > since;
  const recent = sessions.filter((session) => lastMoved(session) > since);
  const read = await Promise.all(
    recent.map(async (session) => ({
      session,
      found: await readAgentFiles(home, folder, session, roots).catch(
        () => null,
      ),
    })),
  );
  const files: AgentFileMarks["files"] = {};
  let partial = false;
  for (const { session, found } of read) {
    if (!found) continue;
    partial ||= found.partial;
    for (const touch of found.files) {
      if (!after(touch.lastAt)) continue;
      const marks = files[touch.path] ?? [];
      marks.push({
        agent: session.agent,
        id: session.id,
        title: session.title,
        lastAt: touch.lastAt,
        via: touch.via,
      });
      files[touch.path] = marks;
    }
  }
  for (const marks of Object.values(files))
    marks.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { files, partial };
}
