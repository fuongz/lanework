// The Claude and Codex conversations a project's folder has on disk (FE-23):
// what the rail's Agents group lists, and the only ids a tab may resume.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake home folder.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_SESSION_LIMIT,
  type AgentSession,
  isAgentSessionId,
} from "../../../shared/terminal";

/** How much of a transcript's start and end is read; never the whole file. */
const CHUNK = 64 * 1024;
/** A Codex `session_meta` line carries the whole system prompt. */
const META_CHUNK = 256 * 1024;
/** Codex keeps every folder's rollouts in one tree; stop looking after this. */
const CODEX_SCAN = 400;
const TITLE_MAX = 120;

type Line = Record<string, unknown>;

async function readRange(
  file: string,
  start: number,
  length: number,
): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The whole lines of a chunk, parsed. A chunk cut mid-line loses that line —
 * the first one of a tail, the last one of a head — and a line that is not
 * JSON is skipped, never thrown on.
 */
function lines(text: string, { head }: { head: boolean }): Line[] {
  const parts = text.split("\n");
  if (head) parts.pop();
  else parts.shift();
  const out: Line[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    try {
      const value: unknown = JSON.parse(part);
      if (value && typeof value === "object") out.push(value as Line);
    } catch {
      // Cut, or not ours.
    }
  }
  return out;
}

/** One line, whitespace collapsed, short enough for a rail row. */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/**
 * A prompt somebody typed, as opposed to what a CLI puts in the user's turn
 * for itself — command caveats, hook output, injected context — which is all
 * wrapped in a tag.
 */
function typed(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.trim();
  if (!clean || clean.startsWith("<")) return null;
  return tidy(clean);
}

/** A conversation's key across both CLIs: ids are only unique per agent. */
export function agentKey(session: Pick<AgentSession, "agent" | "id">): string {
  return `${session.agent}:${session.id}`;
}

/** Claude's folder name for `cwd`: every character but [A-Za-z0-9] is `-`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function claudePrompt(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return typed(content);
  if (Array.isArray(content))
    for (const part of content as { type?: string; text?: unknown }[])
      if (part?.type === "text") return typed(part.text);
  return null;
}

/**
 * Whether a Claude turn is open: a prompt sent, not yet answered (FE-25).
 *
 * ⚠️ Read from the conversation's own STATE, not from the file being
 * written. Opening or resuming a conversation writes bookkeeping — `mode`,
 * `permission-mode`, `cost-state`, `last-prompt`, a title — and a spinner on
 * those is a spinner on nothing. Walking back from the end past that, the
 * first line that says where the turn is decides: the turn's closing
 * `system` line (or an interruption) means idle; a prompt, a tool result or
 * an unfinished assistant message means it is thinking or working.
 */
export function claudeWorking(tail: Line[]): boolean {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (line.isSidechain) continue;
    if (line.type === "system") {
      if (
        line.subtype === "turn_duration" ||
        line.subtype === "stop_hook_summary"
      )
        return false;
      continue;
    }
    if (line.type === "assistant") {
      const stop = (line.message as { stop_reason?: unknown } | undefined)
        ?.stop_reason;
      // `end_turn` alone is not the end: the closing system line follows it.
      if (stop === "tool_use" || stop === null || stop === undefined)
        return true;
      continue;
    }
    if (line.type === "user") {
      if (line.isMeta) continue;
      const content = (line.message as { content?: unknown } | undefined)
        ?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? ((content as { type?: string; text?: unknown }[]).find(
                (part) => part?.type === "text",
              )?.text ?? "")
            : "";
      if (typeof text === "string" && text.startsWith("[Request interrupted"))
        return false;
      // ⚠️ A local command — `/model`, `/clear`, `!ls` — is written as a user
      // line wrapped in a tag, and never reaches the model: not a turn. The
      // same tell `typed()` uses for a title.
      if (typeof text === "string" && text.trimStart().startsWith("<"))
        continue;
      return true;
    }
  }
  return false;
}

/** Whether a Codex task is open: `task_started` with no end after it. */
export function codexWorking(tail: Line[]): boolean {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (line.type !== "event_msg") continue;
    const kind = (line.payload as { type?: unknown } | null)?.type;
    if (kind === "task_started") return true;
    if (kind === "task_complete" || kind === "turn_aborted") return false;
  }
  return false;
}

/** A user line that is a local command — `/model`, `!ls` — not a prompt. */
function localCommand(line: Line): boolean {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? ((content as { type?: string; text?: unknown }[]).find(
            (part) => part?.type === "text",
          )?.text ?? "")
        : "";
  return typeof text === "string" && text.trimStart().startsWith("<");
}

/**
 * When the conversation last MOVED: its newest prompt, answer or closed
 * turn — ISO, or null when the lines read have none.
 *
 * ⚠️ Not the file's mtime. Opening or resuming a conversation appends
 * bookkeeping, and a row that jumped to "now" and to the top every time it
 * was merely looked at would say something false about it.
 */
export function lastActivity(
  tail: Line[],
  agent: "claude" | "codex",
): string | null {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (typeof line.timestamp !== "string") continue;
    if (agent === "claude") {
      if (line.isSidechain || line.isMeta) continue;
      const moved =
        line.type === "assistant" ||
        (line.type === "user" && !localCommand(line)) ||
        (line.type === "system" && line.subtype === "turn_duration");
      if (moved) return line.timestamp;
    } else {
      const payload = line.payload as { type?: unknown; role?: unknown } | null;
      const moved =
        (line.type === "response_item" &&
          payload?.type === "message" &&
          (payload.role === "user" || payload.role === "assistant")) ||
        (line.type === "event_msg" &&
          (payload?.type === "task_started" ||
            payload?.type === "task_complete" ||
            payload?.type === "user_message"));
      if (moved) return line.timestamp;
    }
  }
  return null;
}

/**
 * A turn left open this long is not being worked on — a CLI killed mid-task
 * never writes its end. Long enough for a slow tool run or a long think.
 */
const STALE_MS = 10 * 60_000;

/** Whether the agent behind `file` is working now, from its transcript's end. */
export async function transcriptWorking(
  file: string,
  agent: "claude" | "codex",
): Promise<boolean> {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > STALE_MS) return false;
    const start = Math.max(0, info.size - CHUNK);
    const tail = lines(await readRange(file, start, CHUNK), {
      head: start === 0,
    });
    return agent === "claude" ? claudeWorking(tail) : codexWorking(tail);
  } catch {
    return false;
  }
}

async function claudeSession(
  file: string,
  id: string,
  folder: string,
): Promise<AgentSession | null> {
  const info = await stat(file);
  const head = lines(await readRange(file, 0, CHUNK), { head: true });
  // ⚠️ The folder name is lossy — `a_b` and `a-b` both become `a-b` — so the
  // transcript's own `cwd` has the last word.
  const cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
  if (cwd !== undefined && cwd !== folder) return null;
  const tail =
    info.size > CHUNK
      ? lines(await readRange(file, info.size - CHUNK, CHUNK), { head: false })
      : head;
  // The latest title wins: Claude renames a conversation as it goes.
  const named = [...tail, ...head]
    .reverse()
    .find(
      (line) => line.type === "ai-title" && typeof line.aiTitle === "string",
    )?.aiTitle as string | undefined;
  const prompt = head.map(claudePrompt).find(Boolean);
  const title = named ? tidy(named) : prompt;
  // Nothing was ever asked in it: a CLI opened and closed, nothing to resume.
  if (!title) return null;
  return {
    id,
    agent: "claude",
    title,
    cliTitle: title,
    updatedAt:
      lastActivity(tail, "claude") ??
      lastActivity(head, "claude") ??
      info.mtime.toISOString(),
    pinnedAt: null,
    working:
      Date.now() - info.mtimeMs <= STALE_MS &&
      claudeWorking(info.size > CHUNK ? tail : head),
  };
}

async function claudeSessions(
  home: string,
  folder: string,
  keep: ReadonlySet<string>,
): Promise<AgentSession[]> {
  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const file = join(dir, name);
        const info = await stat(file).catch(() => null);
        return info?.isFile()
          ? { file, id: name.slice(0, -6), at: info.mtimeMs }
          : null;
      }),
  );
  const valid = files
    .filter((entry) => entry !== null && isAgentSessionId(entry.id))
    .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0));
  // A few spare, for the ones that turn out empty or another folder's — and
  // every KEPT one wherever it falls: a pinned conversation stays on the rail
  // however old it gets (FE-25/D1).
  const head = valid.slice(0, AGENT_SESSION_LIMIT * 2);
  const newest = [
    ...head,
    ...valid
      .slice(AGENT_SESSION_LIMIT * 2)
      .filter((entry) => entry && keep.has(`claude:${entry.id}`)),
  ];
  const read = await Promise.all(
    newest.map((entry) =>
      entry
        ? claudeSession(entry.file, entry.id, folder).catch(() => null)
        : null,
    ),
  );
  return read.filter((entry): entry is AgentSession => entry !== null);
}

/** `thread_name` by id from Codex's index; the last entry for an id wins. */
async function codexNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const text = await readFile(
    join(home, ".codex", "session_index.jsonl"),
    "utf8",
  ).catch(() => "");
  for (const line of lines(`${text}\n`, { head: true }))
    if (typeof line.id === "string" && typeof line.thread_name === "string")
      names.set(line.id, line.thread_name);
  return names;
}

/** Newest first: `sessions/YYYY/MM/DD/rollout-….jsonl`, each level sorted. */
async function codexRollouts(root: string): Promise<string[]> {
  const out: string[] = [];
  const down = async (dir: string, depth: number): Promise<void> => {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .sort()
      .reverse();
    for (const name of names) {
      if (out.length >= CODEX_SCAN) return;
      if (depth < 3) await down(join(dir, name), depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
        out.push(join(dir, name));
    }
  };
  await down(root, 0);
  return out;
}

/**
 * The first thing somebody typed into a rollout. Older CLIs log it as an
 * `event_msg`; newer ones only as the user's `response_item`, whose first
 * turn is the AGENTS.md Codex injected — skipped like any tagged context.
 */
function codexPrompt(line: Line): string | null {
  const payload = line.payload as {
    type?: string;
    role?: string;
    message?: unknown;
    content?: unknown;
  } | null;
  if (line.type === "event_msg" && payload?.type === "user_message")
    return typed(payload.message);
  if (
    line.type !== "response_item" ||
    payload?.type !== "message" ||
    payload.role !== "user" ||
    !Array.isArray(payload.content)
  )
    return null;
  for (const part of payload.content as { type?: string; text?: unknown }[]) {
    if (part?.type !== "input_text" || typeof part.text !== "string") continue;
    if (part.text.startsWith("# AGENTS.md")) return null;
    const prompt = typed(part.text);
    if (prompt) return prompt;
  }
  return null;
}

async function codexSessions(
  home: string,
  folder: string,
  keep: ReadonlySet<string>,
): Promise<AgentSession[]> {
  const files = await codexRollouts(join(home, ".codex", "sessions"));
  const names = await codexNames(home);
  const out: AgentSession[] = [];
  // ⚠️ Only Codex's own kept ids: waiting on a Claude one here would read
  // every rollout on the machine looking for it.
  const wanted = [...keep].filter((key) => key.startsWith("codex:"));
  const found = new Set<string>();
  for (const file of files) {
    // Enough of the newest, and every kept one found: stop reading.
    if (
      out.length >= AGENT_SESSION_LIMIT &&
      wanted.every((key) => found.has(key))
    )
      break;
    try {
      const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
      const meta = head.find((line) => line.type === "session_meta")?.payload as
        | { id?: unknown; cwd?: unknown }
        | undefined;
      if (meta?.cwd !== folder || !isAgentSessionId(meta.id)) continue;
      if (out.length >= AGENT_SESSION_LIMIT && !keep.has(`codex:${meta.id}`))
        continue;
      const named = names.get(meta.id);
      const title = named ? tidy(named) : head.map(codexPrompt).find(Boolean);
      if (!title) continue;
      const info = await stat(file);
      found.add(`codex:${meta.id}`);
      const start = Math.max(0, info.size - CHUNK);
      const tail =
        start === 0
          ? head
          : lines(await readRange(file, start, CHUNK), { head: false });
      out.push({
        id: meta.id,
        agent: "codex",
        title,
        cliTitle: title,
        updatedAt:
          lastActivity(tail, "codex") ??
          lastActivity(head, "codex") ??
          info.mtime.toISOString(),
        pinnedAt: null,
        working: Date.now() - info.mtimeMs <= STALE_MS && codexWorking(tail),
      });
    } catch {
      // A rollout being written, or gone: the next one.
    }
  }
  return out;
}

/**
 * Both CLIs' conversations for `folder`, newest first: at most
 * `AGENT_SESSION_LIMIT`, plus every `agent:id` in `keep` that still exists — the
 * pinned ones, which stay however old they are (FE-25/D1).
 *
 * ⚠️ Nothing read here reaches a command line but an id that passed
 * `isAgentSessionId`; titles are text for the rail and nothing else.
 */
export async function listAgentSessions(
  home: string,
  folder: string,
  keep: ReadonlySet<string> = new Set(),
): Promise<AgentSession[]> {
  const [claude, codex] = await Promise.all([
    claudeSessions(home, folder, keep).catch(() => []),
    codexSessions(home, folder, keep).catch(() => []),
  ]);
  const all = [...claude, ...codex].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const kept = all.filter((entry) => keep.has(agentKey(entry)));
  const rest = all
    .filter((entry) => !keep.has(agentKey(entry)))
    .slice(0, AGENT_SESSION_LIMIT);
  return [...kept, ...rest].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * Which conversation a Codex rollout is, if it is `folder`'s — read from its
 * `session_meta`, once, by the activity watcher (FE-25).
 *
 * Answers the id; `false` for a rollout that belongs elsewhere (an answer to
 * keep); `null` when it cannot be told yet — no `session_meta` written, or
 * the file mid-creation — which is worth asking again.
 */
export async function codexRolloutOf(
  file: string,
  folder: string,
): Promise<string | false | null> {
  try {
    const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
    const meta = head.find((line) => line.type === "session_meta")?.payload as
      | { id?: unknown; cwd?: unknown }
      | undefined;
    if (!meta) return null;
    return meta.cwd === folder && isAgentSessionId(meta.id) ? meta.id : false;
  } catch {
    return null;
  }
}
