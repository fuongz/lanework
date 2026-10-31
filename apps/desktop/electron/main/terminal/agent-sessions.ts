// How the CLIs' own files are read for a conversation (FE-23): its title,
// first prompt, card, sub-agents and Codex role, which a Pull and the
// transcript watcher write into Lanework's session store (`sessions/`,
// FE-112), and the archive, the delete and the tab bindings use as they are.
//
// NOTE: Since FE-112 the rail lists the store, not the folder, and a resume
// is checked against the store.
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// drive it under plain Node against a fake home folder.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mentionsAsNames } from "../../../shared/conversation";
import {
  type AgentCard,
  type AgentSession,
  type AgentSubagent,
  isAgentSessionId,
} from "../../../shared/terminal";
import {
  claudeSubagentGoing,
  claudeWorking,
  lastActivity,
  STALE_MS,
  SUBAGENT_STALE_MS,
} from "../transcripts/activity";
import {
  CHUNK,
  CLAUDE_SUBAGENT_FILE,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "../transcripts/jsonl";
import { backgroundCount, listedTranscriptTasks } from "./background-tasks";

// Transitional re-exports (FE-80): import these from `../transcripts/`.
export {
  claudeEndedSubagents,
  claudeSubagentGoing,
  claudeSubagentWorking,
  claudeWorking,
  codexWorking,
  lastActivity,
  STALE_MS,
  transcriptCompleted,
  transcriptWorking,
} from "../transcripts/activity";
export {
  CLAUDE_SUBAGENT_FILE,
  claudeProjectDir,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "../transcripts/jsonl";

/**
 * How far into a transcript its first prompt is looked for when the head
 * holds none.
 *
 * A prompt with an image pasted in is one line of base64, 400KB for one
 * screenshot, and is cut by any head.
 */
const PROMPT_SCAN = 16 * 1024 * 1024;
/** Codex keeps every folder's rollouts in one tree; stop looking after this. */
const CODEX_SCAN = 400;
/** A conversation's newest sub-agents read, at most (FE-33/D4). */
export const SUBAGENT_LIMIT = 20;
/**
 * A prompt somebody typed, tidied for a title.
 *
 * What a CLI puts in the user's turn for itself (command caveats, hook
 * output, injected context) is all wrapped in a tag, and is not one.
 *
 * @returns null for anything but a typed prompt.
 */
export function typed(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.trim();
  if (!clean) return null;
  if (clean.startsWith("<lanework_orchestrate")) {
    // `/orchestrate` (FE-87): the person's request, inside the planning
    // prompt the app sent for them.
    const start = clean.lastIndexOf("<user_request>\n");
    const end = clean.lastIndexOf("\n</user_request>");
    return start === -1 || end < start
      ? null
      : tidy(`/orchestrate ${clean.slice(start + 15, end)}`);
  }
  if (clean.startsWith("<")) return null;
  return tidy(mentionsAsNames(clean));
}

/** A conversation's key across both CLIs: ids are only unique per agent. */
export function agentKey(session: Pick<AgentSession, "agent" | "id">): string {
  return `${session.agent}:${session.id}`;
}

/** The prompt a Claude line holds, if it is one somebody typed. */
export function claudePrompt(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return typed(content);
  if (Array.isArray(content))
    for (const part of content as { type?: string; text?: unknown }[])
      if (part?.type === "text") return typed(part.text);
  return null;
}

/**
 * How far back a transcript is read for the card its agent is on.
 *
 * A card is named at a turn's start, and a long turn writes a lot after it.
 */
const CARD_SCAN = 4 * 1024 * 1024;

/** `mcp__<server>__<tool>`, the name both CLIs give an MCP tool. */
const MCP_TOOL = /^mcp__(.+)__[a-z_]+$/i;

/** The card a Lanework MCP call's arguments name, if `server` is Lanework. */
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
 * The card a transcript line's Lanework MCP call names.
 *
 * Only a call that names a card counts: `get_review`, `set_status`,
 * `toggle_item` and the like (FE-27/D1). A call without a `card`
 * (`list_boards`, `board_summary`) is none.
 *
 * The server is matched on its name containing "lanework", not on one
 * spelling of it: however it was added (`lanework`, `claude_ai_Lanework`), it
 * is the Lanework server.
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
 * The last card named in `file` between byte `start` and `end`.
 *
 * Only a line the newline after it has closed is read: a line being written
 * is left for the next read, which starts where this one's whole lines
 * ended. Only lines that mention Lanework are parsed. At most
 * {@link CARD_SCAN} bytes before `end` are read.
 *
 * @param aligned `start` is the start of a line; otherwise the first, cut
 *   line is skipped.
 * @returns The card, and where the whole lines read end: the next read's
 *   `start`.
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
 * The sub-agents Claude conversation `id` spawned, newest first.
 *
 * Each is `<id>/subagents/agent-<sub>.jsonl` beside its transcript, with a
 * `.meta.json` saying what it was asked to do. Only a recent one's end is
 * read, for whether it is still going; the rest are done. Nested sub-agents
 * are written to the same folder, so they come out flat (FE-33/D6).
 *
 * @param dir Claude's folder for the project.
 * @param now Epoch ms, for what is recent.
 */
export async function claudeSubagents(
  dir: string,
  id: string,
  now = Date.now(),
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
      // A background one may go on long after its conversation went quiet.
      const recent = now - info.mtimeMs <= SUBAGENT_STALE_MS;
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
        working:
          recent &&
          (await claudeSubagentGoing(file, { mtimeMs: info.mtimeMs, tail })),
      };
    }),
  );
}

/**
 * The transcript's `cwd` and first prompt, read line by line from the start.
 *
 * Only for a transcript whose head had no title: the read goes as far as the
 * first prompt's line ends, up to {@link PROMPT_SCAN}, and an image pasted
 * into that prompt makes it hundreds of KB.
 */
async function claudeOpening(
  file: string,
): Promise<{ cwd: unknown; prompt: string | null }> {
  const handle = await open(file, "r");
  let cwd: unknown;
  try {
    let pending = Buffer.alloc(0);
    let at = 0;
    while (at < PROMPT_SCAN) {
      const chunk = Buffer.alloc(META_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, META_CHUNK, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      for (;;) {
        const end = pending.indexOf(0x0a);
        if (end < 0) break;
        const [line] = lines(`${pending.subarray(0, end).toString("utf8")}\n`, {
          head: true,
        });
        pending = pending.subarray(end + 1);
        if (!line) continue;
        if (cwd === undefined && typeof line.cwd === "string") cwd = line.cwd;
        const prompt = claudePrompt(line);
        if (prompt) return { cwd, prompt };
      }
    }
  } finally {
    await handle.close();
  }
  return { cwd, prompt: null };
}

/**
 * One Claude transcript as a rail row.
 *
 * @returns null for another folder's transcript, or one nothing was ever
 *   asked in.
 */
export async function claudeSession(
  file: string,
  id: string,
  folder: string,
): Promise<AgentSession | null> {
  const info = await stat(file);
  const head = lines(await readRange(file, 0, CHUNK), { head: true });
  // NOTE: The folder name is lossy (`a_b` and `a-b` both become `a-b`), so
  // the transcript's own `cwd` has the last word.
  let cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
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
  let prompt = head.map(claudePrompt).find(Boolean) ?? null;
  // A first prompt longer than the head, such as one with an image pasted
  // in, would leave the conversation without a title, and so off the rail.
  if (!named && !prompt) {
    const opening = await claudeOpening(file);
    prompt = opening.prompt;
    cwd ??= opening.cwd;
    if (cwd !== undefined && cwd !== folder) return null;
  }
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
    conductor: null,
    working,
    // Read only for a working one: an idle agent is on no card (FE-27/D1).
    card: working ? await transcriptCard(file, info.size) : null,
    subagents: await claudeSubagents(dirname(file), id),
    // Read on from where the last listing stopped: cheap after the first.
    // A quiet one never opened is not read at all (FE-111/D2).
    background: backgroundCount(
      await listedTranscriptTasks(file, info.mtimeMs).catch(() => []),
    ),
  };
}

/** `thread_name` by id from Codex's index; the last entry for an id wins. */
export async function codexNames(home: string): Promise<Map<string, string>> {
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

/**
 * The newest Codex rollouts under `root`, newest first.
 *
 * The tree is `sessions/YYYY/MM/DD/rollout-….jsonl`, each level sorted. At
 * most {@link CODEX_SCAN} are listed.
 */
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
 * The prompt a Codex rollout line holds, if somebody typed it.
 *
 * Older CLIs log it as an `event_msg`; newer ones only as the user's
 * `response_item`, whose first turn is the AGENTS.md Codex injected. That
 * turn is skipped like any tagged context.
 */
export function codexPrompt(line: Line): string | null {
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

/** What a Codex rollout is, by its `session_meta`. */
type CodexRole =
  | { kind: "conversation" }
  | {
      kind: "spawned";
      root: string;
      nickname: string | null;
      task: string | null;
      role: string | null;
    }
  | { kind: "helper" };

/** A non-blank string, trimmed, or null. */
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * What a Codex rollout is, from its `session_meta` payload.
 *
 * - `conversation`: somebody's conversation.
 * - `spawned`: a thread a conversation spawned, with the conversation at its
 *   root.
 * - `helper`: Codex's own helper (the `guardian` that assesses approvals, a
 *   review), which is neither and is never listed (FE-33/D1).
 *
 * NOTE: All three have the folder's `cwd`. Without this, every approval Codex
 * assessed would be a row of its own on the rail.
 *
 * The root is `session_id`, which a spawned thread's own spawns name too, so
 * nesting flattens to the conversation (FE-33/D6).
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

/**
 * `folder`'s newest Codex conversations, when each one's CLI STARTED, and
 * its rollout.
 *
 * Only the newest `scan` rollouts on the machine written since `since` are
 * read.
 *
 * NOTE: The start is `session_meta`'s own `timestamp`, not the file's. Codex
 * writes a rollout only once somebody types, but stamps it with the moment
 * the thread began, which is what ties it to the tab that launched it.
 *
 * @param since Epoch ms.
 */
export async function codexStarts(
  home: string,
  folder: string,
  since = 0,
  scan = 40,
): Promise<{ id: string; startedAt: number; file: string }[]> {
  const files = (await codexRollouts(join(home, ".codex", "sessions"))).slice(
    0,
    scan,
  );
  const out: { id: string; startedAt: number; file: string }[] = [];
  for (const file of files) {
    try {
      // Not written since `since`: no tab asking could be its, and not worth
      // opening, as this runs on every write of a turn.
      if ((await stat(file)).mtimeMs < since) continue;
      const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
      const meta = head.find((line) => line.type === "session_meta")?.payload as
        | { id?: unknown; cwd?: unknown; timestamp?: unknown }
        | undefined;
      if (meta?.cwd !== folder || !isAgentSessionId(meta.id)) continue;
      // NOTE: A thread Codex started for itself starts after the tab too, and
      // is never the conversation a tab is on.
      if (codexRole(meta).kind !== "conversation") continue;
      const startedAt =
        typeof meta.timestamp === "string" ? Date.parse(meta.timestamp) : NaN;
      if (Number.isFinite(startedAt))
        out.push({ id: meta.id, startedAt, file });
    } catch {
      // A rollout being written, or gone.
    }
  }
  return out;
}

/**
 * Which conversation a Codex rollout is, if it is `folder`'s.
 *
 * Read from its `session_meta`, once per rollout, by the activity watcher.
 *
 * @returns
 * - Its id, and for a thread a conversation spawned that conversation's as
 *   `parent`.
 * - `false` for a rollout that belongs elsewhere or is Codex's own helper:
 *   an answer to keep.
 * - `null` when it cannot be told yet (no `session_meta` written, or the
 *   file mid-creation), which is worth asking again.
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
