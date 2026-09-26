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
  return { id, agent: "claude", title, updatedAt: info.mtime.toISOString() };
}

async function claudeSessions(
  home: string,
  folder: string,
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
  const newest = files
    .filter((entry) => entry !== null && isAgentSessionId(entry.id))
    .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
    // A few spare, for the ones that turn out empty or another folder's.
    .slice(0, AGENT_SESSION_LIMIT * 2);
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
): Promise<AgentSession[]> {
  const files = await codexRollouts(join(home, ".codex", "sessions"));
  const names = await codexNames(home);
  const out: AgentSession[] = [];
  for (const file of files) {
    if (out.length >= AGENT_SESSION_LIMIT) break;
    try {
      const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
      const meta = head.find((line) => line.type === "session_meta")?.payload as
        | { id?: unknown; cwd?: unknown }
        | undefined;
      if (meta?.cwd !== folder || !isAgentSessionId(meta.id)) continue;
      const named = names.get(meta.id);
      const title = named ? tidy(named) : head.map(codexPrompt).find(Boolean);
      if (!title) continue;
      const info = await stat(file);
      out.push({
        id: meta.id,
        agent: "codex",
        title,
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // A rollout being written, or gone: the next one.
    }
  }
  return out;
}

/**
 * Both CLIs' conversations for `folder`, newest first, at most
 * `AGENT_SESSION_LIMIT`.
 *
 * ⚠️ Nothing read here reaches a command line but an id that passed
 * `isAgentSessionId`; titles are text for the rail and nothing else.
 */
export async function listAgentSessions(
  home: string,
  folder: string,
): Promise<AgentSession[]> {
  const [claude, codex] = await Promise.all([
    claudeSessions(home, folder).catch(() => []),
    codexSessions(home, folder).catch(() => []),
  ]);
  return [...claude, ...codex]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, AGENT_SESSION_LIMIT);
}
