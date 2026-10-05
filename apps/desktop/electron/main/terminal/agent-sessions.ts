// The Claude and Codex conversations a project's folder has on disk (FE-23):
// what the rail's Agents group lists, and the only ids a tab may resume.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake home folder.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AGENT_SESSION_LIMIT,
  type AgentCard,
  type AgentSession,
  type AgentSubagent,
  isAgentSessionId,
} from "../../../shared/terminal";
import { backgroundCount, readTranscriptTasks } from "./background-tasks";

/** How much of a transcript's start and end is read; never the whole file. */
const CHUNK = 64 * 1024;
/** A Codex `session_meta` line carries the whole system prompt. */
export const META_CHUNK = 256 * 1024;
/** Codex keeps every folder's rollouts in one tree; stop looking after this. */
const CODEX_SCAN = 400;
const TITLE_MAX = 120;
/** A conversation's newest sub-agents read, at most (FE-33/D4). */
const SUBAGENT_LIMIT = 20;
/** Claude's name for a sub-agent's transcript, beside its `.meta.json`. */
export const CLAUDE_SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

export type Line = Record<string, unknown>;

export async function readRange(
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
export function lines(text: string, { head }: { head: boolean }): Line[] {
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
export function tidy(text: string): string {
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

/**
 * Whether a Claude sub-agent is still going (FE-33): its newest word is not
 * a finished answer.
 *
 * ⚠️ Not `claudeWorking`: every line of a sub-agent is a sidechain, and its
 * run ends AT the answer — no closing `system` line follows it. Two ends:
 * an `end_turn` answer, or (newer CLIs) the result of the tool it hands its
 * report back with, which says `toolEndsTurn`.
 */
export function claudeSubagentWorking(tail: Line[]): boolean {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (line.type === "assistant") {
      const stop = (line.message as { stop_reason?: unknown } | undefined)
        ?.stop_reason;
      return stop === "tool_use" || stop === null || stop === undefined;
    }
    if (line.type === "user" && !line.isMeta) {
      if (line.toolEndsTurn === true) return false;
      const content = (line.message as { content?: unknown } | undefined)
        ?.content;
      return !(
        typeof content === "string" &&
        content.startsWith("[Request interrupted")
      );
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
export const STALE_MS = 10 * 60_000;

/**
 * Whether the agent behind `file` is working now, from its transcript's end
 * — a conversation's, or one of its sub-agents' (FE-33).
 */
export async function transcriptWorking(
  file: string,
  agent: "claude" | "codex",
  subagent = false,
): Promise<boolean> {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > STALE_MS) return false;
    const start = Math.max(0, info.size - CHUNK);
    const tail = lines(await readRange(file, start, CHUNK), {
      head: start === 0,
    });
    if (agent === "codex") return codexWorking(tail);
    return subagent ? claudeSubagentWorking(tail) : claudeWorking(tail);
  } catch {
    return false;
  }
}

/**
 * How far back a transcript is read for the card its agent is on (FE-27): a
 * card is named at a turn's start, and a long turn writes a lot after it.
 */
const CARD_SCAN = 4 * 1024 * 1024;

/** `mcp__<server>__<tool>`, the name both CLIs give an MCP tool. */
const MCP_TOOL = /^mcp__(.+)__[a-z_]+$/i;

function cardOf(server: unknown, args: unknown): AgentCard | null {
  if (typeof server !== "string" || !/lanework/i.test(server)) return null;
  const { board_id: boardId, card } = (args ?? {}) as {
    board_id?: unknown;
    card?: unknown;
  };
  return typeof boardId === "string" &&
    boardId &&
    typeof card === "string" &&
    card
    ? { boardId, card }
    : null;
}

/**
 * The card a transcript line's Lanework MCP call names, if it is one that
 * names a card — `get_review`, `set_status`, `toggle_item` and the like
 * (FE-27/D1). A call without a `card` (`list_boards`, `board_summary`) is
 * none.
 *
 * ⚠️ Matched on the MCP SERVER's name, not on one spelling of it: however it
 * was added — `lanework`, `claude_ai_Lanework` — it is the Lanework server.
 */
export function laneworkCard(line: Line): AgentCard | null {
  // Claude: an assistant message's `tool_use` parts.
  if (line.type === "assistant") {
    const content = (line.message as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) return null;
    for (let at = content.length - 1; at >= 0; at--) {
      const part = content[at] as {
        type?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (part?.type !== "tool_use" || typeof part.name !== "string") continue;
      const found = cardOf(MCP_TOOL.exec(part.name)?.[1], part.input);
      if (found) return found;
    }
    return null;
  }
  const payload = line.payload as Record<string, unknown> | null | undefined;
  if (!payload) return null;
  // Codex: an `McpToolCall` item, started or completed.
  if (line.type === "event_msg") {
    const item = payload.item as Record<string, unknown> | undefined;
    if (item?.type === "McpToolCall")
      return cardOf(item.server, item.arguments);
    const call = payload.invocation as Record<string, unknown> | undefined;
    return call ? cardOf(call.server, call.arguments) : null;
  }
  // Codex, older: a `function_call` whose arguments are a JSON string.
  if (
    line.type === "response_item" &&
    payload.type === "function_call" &&
    typeof payload.name === "string"
  ) {
    const server = MCP_TOOL.exec(payload.name)?.[1];
    if (!server || typeof payload.arguments !== "string") return null;
    try {
      return cardOf(server, JSON.parse(payload.arguments));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The last card named in `file` between byte `start` and `end`, and where
 * the whole lines read end — the next read's `start` (FE-27).
 *
 * ⚠️ Only a line the newline after it has closed is read: a line being
 * written is left for the next read, which starts where this one's whole
 * lines ended. `aligned` says `start` is such a place; otherwise the first,
 * cut line is skipped. Only lines that mention Lanework are parsed.
 */
export async function lastCardIn(
  file: string,
  start: number,
  end: number,
  aligned: boolean,
): Promise<{ card: AgentCard | null; end: number }> {
  const from = end - start > CARD_SCAN ? end - CARD_SCAN : start;
  const whole = aligned && from === start;
  const handle = await open(file, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(end - from);
    const { bytesRead } = await handle.read(buffer, 0, end - from, from);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const last = buffer.lastIndexOf(0x0a);
  if (last === -1) return { card: null, end: whole ? from : start };
  let stop = last;
  while (stop > 0) {
    const begin = buffer.lastIndexOf(0x0a, stop - 1) + 1;
    // The first piece of a read that began mid-line is not a line.
    if (begin === 0 && !whole && from > 0) break;
    const piece = buffer.subarray(begin, stop);
    if (piece.includes("lanework") || piece.includes("Lanework")) {
      const [line] = lines(`${piece.toString("utf8")}\n`, { head: true });
      const card = line ? laneworkCard(line) : null;
      if (card) return { card, end: from + last + 1 };
    }
    stop = begin - 1;
  }
  return { card: null, end: from + last + 1 };
}

/** The card the agent behind `file` last named, from its recent past. */
async function transcriptCard(
  file: string,
  size: number,
): Promise<AgentCard | null> {
  return (
    (await lastCardIn(file, 0, size, true).catch(() => null))?.card ?? null
  );
}

/**
 * The sub-agents Claude conversation `id` spawned (FE-33), newest first:
 * `<id>/subagents/agent-<sub>.jsonl` beside its transcript, each with a
 * `.meta.json` saying what it was asked to do.
 *
 * ⚠️ Only a recent one's end is read, for whether it is still going; the
 * rest are done. Nested sub-agents are written to the same folder, so they
 * come out flat (FE-33/D6).
 */
async function claudeSubagents(
  dir: string,
  id: string,
): Promise<AgentSubagent[]> {
  const folder = join(dir, id, "subagents");
  const names = await readdir(folder).catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name) => {
      const sub = CLAUDE_SUBAGENT_FILE.exec(name)?.[1];
      if (!sub) return null;
      const file = join(folder, name);
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? { sub, file, info } : null;
    }),
  );
  const newest = files
    .filter((entry) => entry !== null)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, SUBAGENT_LIMIT);
  return Promise.all(
    newest.map(async ({ sub, file, info }) => {
      const meta = (await readFile(
        join(folder, `agent-${sub}.meta.json`),
        "utf8",
      )
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => null)) as {
        description?: unknown;
        agentType?: unknown;
      } | null;
      const described =
        typeof meta?.description === "string" && meta.description.trim()
          ? tidy(meta.description)
          : null;
      // No meta: what it was asked, its first line.
      const title =
        described ??
        lines(await readRange(file, 0, CHUNK).catch(() => ""), { head: true })
          .filter((line) => line.type === "user")
          .map((line) =>
            typed((line.message as { content?: unknown })?.content),
          )
          .find(Boolean) ??
        "Sub-agent";
      const recent = Date.now() - info.mtimeMs <= STALE_MS;
      const tail = recent
        ? lines(await readRange(file, Math.max(0, info.size - CHUNK), CHUNK), {
            head: info.size <= CHUNK,
          })
        : [];
      return {
        id: sub,
        title,
        type:
          typeof meta?.agentType === "string" && meta.agentType
            ? meta.agentType
            : null,
        updatedAt: info.mtime.toISOString(),
        working: recent && claudeSubagentWorking(tail),
      };
    }),
  );
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
  const working =
    Date.now() - info.mtimeMs <= STALE_MS &&
    claudeWorking(info.size > CHUNK ? tail : head);
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
    working,
    // Read only for a working one: an idle agent is on no card (FE-27/D1).
    card: working ? await transcriptCard(file, info.size) : null,
    subagents: await claudeSubagents(dirname(file), id),
    // Read on from where the last listing stopped (FE-42): cheap after once.
    background: backgroundCount(
      await readTranscriptTasks(file).catch(() => []),
    ),
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
export async function codexRollouts(root: string): Promise<string[]> {
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

/** What a Codex rollout is, by its `session_meta` (FE-33). */
export type CodexRole =
  | { kind: "conversation" }
  | {
      kind: "spawned";
      root: string;
      nickname: string | null;
      task: string | null;
      role: string | null;
    }
  | { kind: "helper" };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Somebody's conversation; a thread a conversation spawned, and the
 * conversation at its root; or Codex's own helper — the `guardian` that
 * assesses approvals, a review — which is neither and is never listed
 * (FE-33/D1).
 *
 * ⚠️ All three have the folder's `cwd`. Without this, every approval Codex
 * had assessed was a row of its own on the rail.
 *
 * ⚠️ The root is `session_id` — a spawned thread's own spawns name the same
 * one — so nesting flattens to the conversation (FE-33/D6).
 */
export function codexRole(meta: Record<string, unknown>): CodexRole {
  const source = meta.source;
  if (!source || typeof source !== "object" || !("subagent" in source))
    return { kind: "conversation" };
  const spawn = (source.subagent as { thread_spawn?: unknown } | null)
    ?.thread_spawn as Record<string, unknown> | undefined;
  if (!spawn) return { kind: "helper" };
  const root = [meta.session_id, spawn.parent_thread_id, meta.parent_thread_id]
    .filter(isAgentSessionId)
    .find((id) => id !== meta.id);
  if (!root) return { kind: "helper" };
  // `/root/social_card` → `social card`: the task it was spawned for.
  const path = text(spawn.agent_path ?? meta.agent_path);
  return {
    kind: "spawned",
    root,
    nickname: text(spawn.agent_nickname ?? meta.agent_nickname),
    task: path ? (path.split("/").pop()?.replace(/_/g, " ") ?? null) : null,
    role: text(spawn.agent_role),
  };
}

async function codexSessions(
  home: string,
  folder: string,
  keep: ReadonlySet<string>,
): Promise<AgentSession[]> {
  const files = await codexRollouts(join(home, ".codex", "sessions"));
  const names = await codexNames(home);
  const out: AgentSession[] = [];
  /**
   * The threads each conversation spawned, by its id (FE-33). A spawned
   * thread starts after its conversation, so newest-first meets it first.
   */
  const spawned = new Map<string, AgentSubagent[]>();
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
      const role = codexRole(meta);
      if (role.kind === "helper") continue;
      if (role.kind === "spawned") {
        const siblings = spawned.get(role.root) ?? [];
        if (siblings.length >= SUBAGENT_LIMIT) continue;
        spawned.set(role.root, siblings);
        const info = await stat(file);
        const recent = Date.now() - info.mtimeMs <= STALE_MS;
        const start = Math.max(0, info.size - CHUNK);
        const tail = !recent
          ? []
          : start === 0
            ? head
            : lines(await readRange(file, start, CHUNK), { head: false });
        // ⚠️ What it was told is sealed in its spawner's call; the task
        // name it was spawned under is what is left to call it by.
        const task = role.task ?? head.map(codexPrompt).find(Boolean) ?? null;
        siblings.push({
          id: meta.id,
          title:
            [role.nickname, task].filter(Boolean).join(": ") || "Sub-agent",
          type: role.role,
          updatedAt: lastActivity(tail, "codex") ?? info.mtime.toISOString(),
          working: recent && codexWorking(tail),
        });
        continue;
      }
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
      const working =
        Date.now() - info.mtimeMs <= STALE_MS && codexWorking(tail);
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
        working,
        card: working ? await transcriptCard(file, info.size) : null,
        subagents: spawned.get(meta.id) ?? [],
        // Codex keeps no background tasks in its rollout (FE-42/D4).
        background: { running: 0, total: 0 },
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
 * `folder`'s newest Codex conversations and when each one's CLI STARTED
 * (FE-31), among the newest `scan` rollouts on the machine written since
 * `since`.
 *
 * ⚠️ The start is `session_meta`'s own `timestamp`, not the file's: Codex
 * writes a rollout only once somebody types, but stamps it with the moment
 * the thread began — which is what ties it to the tab that launched it.
 */
export async function codexStarts(
  home: string,
  folder: string,
  since = 0,
  scan = 40,
): Promise<{ id: string; startedAt: number }[]> {
  const files = (await codexRollouts(join(home, ".codex", "sessions"))).slice(
    0,
    scan,
  );
  const out: { id: string; startedAt: number }[] = [];
  for (const file of files) {
    try {
      // ⚠️ Not written since `since`: no tab asking could be its — and not
      // worth opening, as this runs on every write of a turn.
      if ((await stat(file)).mtimeMs < since) continue;
      const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
      const meta = head.find((line) => line.type === "session_meta")?.payload as
        | { id?: unknown; cwd?: unknown; timestamp?: unknown }
        | undefined;
      if (meta?.cwd !== folder || !isAgentSessionId(meta.id)) continue;
      // ⚠️ A thread Codex started for itself starts after the tab too, and
      // is never the conversation a tab is on (FE-33).
      if (codexRole(meta).kind !== "conversation") continue;
      const startedAt =
        typeof meta.timestamp === "string" ? Date.parse(meta.timestamp) : NaN;
      if (Number.isFinite(startedAt)) out.push({ id: meta.id, startedAt });
    } catch {
      // A rollout being written, or gone.
    }
  }
  return out;
}

/**
 * Which conversation a Codex rollout is, if it is `folder`'s — read from its
 * `session_meta`, once, by the activity watcher (FE-25).
 *
 * Answers its id, and for a thread a conversation spawned that
 * conversation's as `parent` (FE-33); `false` for a rollout that belongs
 * elsewhere or is Codex's own helper (an answer to keep); `null` when it
 * cannot be told yet — no `session_meta` written, or the file mid-creation —
 * which is worth asking again.
 */
export async function codexRolloutOf(
  file: string,
  folder: string,
): Promise<{ id: string; parent: string | null } | false | null> {
  try {
    const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
    const meta = head.find((line) => line.type === "session_meta")?.payload as
      | { id?: unknown; cwd?: unknown }
      | undefined;
    if (!meta) return null;
    if (meta.cwd !== folder || !isAgentSessionId(meta.id)) return false;
    const role = codexRole(meta);
    if (role.kind === "helper") return false;
    return { id: meta.id, parent: role.kind === "spawned" ? role.root : null };
  } catch {
    return null;
  }
}
