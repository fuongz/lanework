// Whether an agent is working, read from the end of its transcript: an open
// turn, a sub-agent's unfinished run, a Codex task, when it last moved.
//
// NOTE: A leaf over `./jsonl` (FE-80, AM-03). The rail's session list and the
// background tasks both ask it, and asking `agent-sessions.ts` made the two
// import each other. Node only, no Electron.
import { open, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  CHUNK,
  CLAUDE_SUBAGENT_FILE,
  type Line,
  lines,
  readRange,
} from "./jsonl";

/**
 * Whether a user line is the CLI's own wrapped text (a local command, hook
 * output), which never reaches the model as a turn.
 *
 * NOTE: Lanework's own envelopes (`<lanework_…>`, FE-87) are tagged too, but
 * they are turns the model answers.
 */
export function cliTagged(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const start = text.trimStart();
  return start.startsWith("<") && !start.startsWith("<lanework_");
}

/**
 * Whether a Claude turn is open: a prompt sent, not yet answered (FE-25).
 *
 * NOTE: Read from the conversation's own STATE, not from the file being
 * written. Opening or resuming a conversation writes bookkeeping (`mode`,
 * `permission-mode`, `cost-state`, `last-prompt`, a title), and a spinner on
 * those is a spinner on nothing. Walking back from the end past that, the
 * first line that says where the turn is decides:
 * - the turn's closing `system` line, or an interruption, means idle;
 * - a prompt, a tool result or an unfinished assistant message means it is
 *   thinking or working.
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
      // NOTE: A local command (`/model`, `/clear`, `!ls`) is written as a
      // user line wrapped in a tag, and never reaches the model: not a turn.
      // The same tell `typed()` uses for a title.
      if (cliTagged(text)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a Claude sub-agent is still going: its newest word is not a
 * finished answer.
 *
 * NOTE: Not {@link claudeWorking}: every line of a sub-agent is a sidechain,
 * and its run ends AT the answer, with no closing `system` line after it. It
 * has two ends: an `end_turn` answer, or (newer CLIs) the result of the tool
 * it hands its report back with, which says `toolEndsTurn`.
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

/** A background task's end, as the conversation that ran it is told. */
const TASK_NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TASK_ID = /<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/;
const TASK_STATUS = /<status>([a-z_]+)<\/status>/;

/** How much of a conversation's transcript one read for task ends takes. */
const ENDED_READ = 4 * 1024 * 1024;

/**
 * What each conversation's transcript has been read for: how far, and the
 * sub-agents it says have ended. Only the bytes written since are read again.
 */
const endedRead = new Map<string, { end: number; ended: Set<string> }>();

/**
 * The background sub-agents a Claude conversation was told have ended.
 *
 * NOTE: A sub-agent stopped mid-turn (TaskStop, a crash) never writes the
 * line that closes its turn, so its own transcript reads as working until it
 * goes stale. Its conversation is told: a `<task-notification>` with the
 * sub-agent's id and a status other than `running`.
 *
 * @param conversation The conversation's own transcript, `<id>.jsonl`.
 * @returns The ids, as in `agent-<id>.jsonl`. Empty when it cannot be read.
 */
export async function claudeEndedSubagents(
  conversation: string,
): Promise<Set<string>> {
  try {
    const { size } = await stat(conversation);
    let known = endedRead.get(conversation);
    // Shorter than what was read: rewritten, so read it as new.
    if (!known || known.end > size) {
      known = { end: 0, ended: new Set() };
      endedRead.set(conversation, known);
    }
    const handle = await open(conversation, "r");
    try {
      const buffer = Buffer.alloc(Math.min(ENDED_READ, size - known.end));
      while (known.end < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - known.end),
          known.end,
        );
        if (bytesRead === 0) break;
        // Whole lines only, found in the bytes: a notification cut at the
        // read's end is read with the next one.
        const last = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (last === -1) {
          // The line is still being written: try again on the next read.
          if (known.end + bytesRead >= size) break;
          // A line longer than a whole read (a pasted image) is skipped, or
          // every read after it would stop here.
          known.end += bytesRead;
          continue;
        }
        const text = buffer.subarray(0, last).toString("utf8");
        for (const [block] of text.matchAll(TASK_NOTIFICATION)) {
          const id = TASK_ID.exec(block)?.[1];
          const status = TASK_STATUS.exec(block)?.[1];
          if (id && status && status !== "running") known.ended.add(id);
        }
        known.end += last + 1;
      }
    } finally {
      await handle.close();
    }
    return known.ended;
  } catch {
    return new Set();
  }
}

/** The conversation transcript a Claude sub-agent's file belongs to. */
function conversationOfSubagent(file: string): string {
  // `<dir>/<id>/subagents/agent-<sub>.jsonl` → `<dir>/<id>.jsonl`.
  return `${dirname(dirname(file))}.jsonl`;
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

/** Whether a user line is a local command (`/model`, `!ls`), not a prompt. */
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
  return cliTagged(text);
}

/**
 * When the conversation last MOVED: its newest prompt, answer or closed turn.
 *
 * NOTE: Not the file's mtime. Opening or resuming a conversation appends
 * bookkeeping, and a row that jumped to "now" and to the top every time it
 * was merely looked at would say something false about it.
 *
 * @returns An ISO time, or null when the lines read have none.
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
 * How long a turn may stay open and still be worked on.
 *
 * A CLI killed mid-task never writes its end. This is long enough for a slow
 * tool run or a long think.
 */
export const STALE_MS = 10 * 60_000;

/**
 * Whether the newest turn of `file` really ended.
 *
 * @returns false for an interruption, a missing file or a stale run.
 */
export async function transcriptCompleted(
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
    if (agent === "codex") {
      for (const line of tail.reverse()) {
        if (line.type !== "event_msg") continue;
        const kind = (line.payload as { type?: unknown } | null)?.type;
        if (kind === "task_complete") return true;
        if (kind === "task_started" || kind === "turn_aborted") return false;
      }
      return false;
    }
    // A stop hook may run even after Ctrl-C. The turn must have an answer,
    // and no later prompt/interruption, as well as its closing system line.
    let closed = false;
    for (const line of tail.reverse()) {
      if (line.isSidechain) continue;
      if (
        line.type === "system" &&
        (line.subtype === "turn_duration" ||
          line.subtype === "stop_hook_summary")
      )
        closed = true;
      if (line.type === "user" && !line.isMeta && !localCommand(line))
        return false;
      if (line.type === "assistant")
        return (
          closed &&
          (line.message as { stop_reason?: unknown } | undefined)
            ?.stop_reason === "end_turn"
        );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether the agent behind `file` is working now, from its transcript's end.
 *
 * @param subagent `file` is one of a conversation's sub-agents, not the
 *   conversation.
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
    if (!subagent) return claudeWorking(tail);
    return claudeSubagentWorking(tail) && !(await claudeSubagentEnded(file));
  } catch {
    return false;
  }
}

/** Whether a Claude sub-agent's conversation was told it ended. */
export async function claudeSubagentEnded(file: string): Promise<boolean> {
  const sub = CLAUDE_SUBAGENT_FILE.exec(basename(file))?.[1];
  if (!sub) return false;
  return (await claudeEndedSubagents(conversationOfSubagent(file))).has(sub);
}
