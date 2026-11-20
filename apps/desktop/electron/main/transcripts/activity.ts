// Whether an agent is working, read from the end of its transcript: an open
// turn, a sub-agent's unfinished run, a Codex task, when it last moved.
//
// NOTE: A leaf over `./jsonl` and `./journal` (FE-80, AM-03). The rail's session list and the
// background tasks both ask it, and asking `agent-sessions.ts` made the two
// import each other. Node only, no Electron.
import { open, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isLaneworkEnvelope } from "../../../shared/conversation";
import { readJournal } from "./journal";
import {
  CHUNK,
  CLAUDE_SUBAGENT_FILE,
  eachLine,
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
  return start.startsWith("<") && !isLaneworkEnvelope(start);
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
      // NOTE: An API error (a usage limit, an overload) ends the turn, and
      // the CLI writes no closing system line after it: read on to the
      // prompt, the turn looked like it was still working.
      if (line.isApiErrorMessage === true || typeof line.error === "string")
        return false;
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

/** A task's notification, as the conversation that ran it is told. */
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/** EVERY task a notification names: a resumed session's names several. */
const TASK_ID = /<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/g;
const TASK_STATUS = /<status>([a-z_]+)<\/status>/;

/**
 * What a line of a conversation must hold to say anything of its sub-agents'
 * ends. A line holding none is never parsed: a transcript runs to tens of MB.
 */
const ENDS_MARKERS = [
  '"name":"Agent"',
  '"name":"Task"',
  "task-notification",
  "[Request interrupted",
  "Successfully stopped task",
  '"agentId"',
];
/** Read too while a foreground call is open: its answer, or the turn's end. */
const OPEN_MARKERS = ['"tool_use_id"', "turn_duration", "stop_hook_summary"];

/** What a Claude conversation's transcript says of its sub-agents' ends. */
export interface SubagentEnds {
  /** When each sub-agent was last said to have ended, by its id: epoch ms. */
  agents: Map<string, number>;
  /**
   * When each `Agent`/`Task` call was answered or cut off, by its
   * `tool_use` id: epoch ms. A sub-agent's `.meta.json` names its call.
   */
  calls: Map<string, number>;
  /** The sub-agents started in the background (`async_launched`). */
  background: Set<string>;
}

/** {@link SubagentEnds} as far as one transcript was read. */
interface EndsRead extends SubagentEnds {
  /** Bytes read, up to the end of the last whole line. */
  end: number;
  /** `Agent`/`Task` calls not answered yet. */
  open: Set<string>;
}

/** Conversations whose read is kept, oldest read first. */
const ENDS_CACHE_MAX = 128;
/** Each conversation's read so far: only the bytes written since are read. */
const endsRead = new Map<string, EndsRead>();
/** One read of a conversation at a time: a second waits and takes the cache. */
const endsReading = new Map<string, Promise<SubagentEnds>>();

/** `value` as a plain object, or null. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Note that `id` ended at `when`: the latest end of it wins. */
function endAt(ends: Map<string, number>, id: string, when: number) {
  const prior = ends.get(id);
  if (prior === undefined || when > prior) ends.set(id, when);
}

/** Every task a finished notification in `text` names, ended at `when`. */
function notified(read: EndsRead, text: string, when: number) {
  for (const [, body] of text.matchAll(TASK_NOTIFICATION)) {
    const status = TASK_STATUS.exec(body)?.[1];
    // No status (a Monitor's event) or `running`: news, not an end.
    if (!status || status === "running") continue;
    for (const [, id] of body.matchAll(TASK_ID)) endAt(read.agents, id, when);
  }
}

/** One line of a conversation, folded into what it says of its ends. */
function visitEnds(read: EndsRead, text: string) {
  // The CLI's request bookkeeping quotes the tool docs, examples and all.
  if (text.startsWith('{"type":"api-request')) return;
  if (
    !ENDS_MARKERS.some((marker) => text.includes(marker)) &&
    !(read.open.size > 0 && OPEN_MARKERS.some((m) => text.includes(m)))
  )
    return;
  let line: Line;
  try {
    const value = record(JSON.parse(text));
    if (!value) return;
    line = value;
  } catch {
    return;
  }
  if (line.isSidechain === true) return;
  const stamp =
    typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  // No time on it: an end whatever was written before.
  const when = Number.isFinite(stamp) ? stamp : Number.POSITIVE_INFINITY;
  // The turn is over: every foreground call still open ended with it.
  const cutOff = () => {
    for (const id of read.open) endAt(read.calls, id, when);
    read.open.clear();
  };
  if (line.type === "assistant") {
    const content = record(line.message)?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const item = record(part);
      if (
        item?.type === "tool_use" &&
        (item.name === "Agent" || item.name === "Task") &&
        typeof item.id === "string"
      )
        read.open.add(item.id);
    }
    return;
  }
  if (line.type === "system") {
    if (
      line.subtype === "turn_duration" ||
      line.subtype === "stop_hook_summary"
    )
      cutOff();
    return;
  }
  if (line.type === "queue-operation") {
    if (typeof line.content === "string") notified(read, line.content, when);
    return;
  }
  if (line.type === "attachment") {
    const prompt = record(line.attachment)?.prompt;
    if (typeof prompt === "string") notified(read, prompt, when);
    return;
  }
  if (line.type !== "user") return;
  const content = record(line.message)?.content;
  const parts = Array.isArray(content) ? content.map(record) : [];
  const said =
    typeof content === "string"
      ? content
      : parts
          .map((part) =>
            part?.type === "text" && typeof part.text === "string"
              ? part.text
              : "",
          )
          .join("\n");
  if (said.includes("<task-notification>")) notified(read, said, when);
  if (said.trimStart().startsWith("[Request interrupted")) cutOff();
  const result = record(line.toolUseResult);
  // `TaskStop`: no notification follows, its answer is the only word.
  const message = result?.message;
  const stopped = result?.task_id ?? result?.shell_id;
  if (
    typeof message === "string" &&
    message.startsWith("Successfully stopped task") &&
    typeof stopped === "string"
  )
    endAt(read.agents, stopped, when);
  for (const part of parts) {
    const id = part?.type === "tool_result" ? part.tool_use_id : null;
    if (typeof id !== "string" || !read.open.delete(id)) continue;
    const agent = typeof result?.agentId === "string" ? result.agentId : null;
    // Started in the background: answered at once, and it ends later.
    if (result?.isAsync === true || result?.status === "async_launched") {
      if (agent) read.background.add(agent);
      continue;
    }
    // A foreground one: its answer, or its refusal, is its end.
    endAt(read.calls, id, when);
    if (agent) endAt(read.agents, agent, when);
  }
}

async function readEnds(conversation: string): Promise<SubagentEnds> {
  const { size } = await stat(conversation);
  const cached = endsRead.get(conversation);
  // Shorter than what was read: rewritten, so read it as new.
  const read: EndsRead =
    cached && cached.end <= size
      ? cached
      : {
          end: 0,
          open: new Set(),
          agents: new Map(),
          calls: new Map(),
          background: new Set(),
        };
  endsRead.delete(conversation);
  endsRead.set(conversation, read);
  while (endsRead.size > ENDS_CACHE_MAX) {
    const oldest = endsRead.keys().next().value;
    if (oldest === undefined) break;
    endsRead.delete(oldest);
  }
  if (read.end < size)
    read.end = await eachLine(conversation, read.end, (line) =>
      visitEnds(read, line),
    );
  return read;
}

/**
 * What a Claude conversation says of its sub-agents' ends (FE-100).
 *
 * NOTE: A sub-agent stopped mid-turn (TaskStop, a crash, its conversation's
 * Esc) never writes the line that closes its turn, so its own transcript
 * reads as working until it goes stale. Its conversation is told:
 * - a foreground one, by the answer to the `Agent` call that spawned it, or
 *   by the interruption or close of the turn that call was in;
 * - a background one, by a `<task-notification>` naming it with a status
 *   other than `running`, or by the answer to the `TaskStop` that stopped it.
 *
 * Read incrementally, one read of a conversation at a time.
 *
 * @param conversation The conversation's own transcript, `<id>.jsonl`.
 * @returns Empty when it cannot be read.
 */
export function claudeSubagentEnds(
  conversation: string,
): Promise<SubagentEnds> {
  const prior = endsReading.get(conversation) ?? Promise.resolve(null);
  const next = prior
    .catch(() => null)
    .then(() => readEnds(conversation))
    .catch(
      (): SubagentEnds => ({
        agents: new Map(),
        calls: new Map(),
        background: new Set(),
      }),
    );
  endsReading.set(conversation, next);
  void next.then(() => {
    if (endsReading.get(conversation) === next)
      endsReading.delete(conversation);
  });
  return next;
}

/**
 * The background sub-agents a Claude conversation was told have ended.
 *
 * @param conversation The conversation's own transcript, `<id>.jsonl`.
 * @returns The ids, as in `agent-<id>.jsonl`. Empty when it cannot be read.
 */
export async function claudeEndedSubagents(
  conversation: string,
): Promise<Set<string>> {
  return new Set((await claudeSubagentEnds(conversation)).agents.keys());
}

/**
 * Where a Claude sub-agent's file is: the conversation transcript it belongs
 * to, and the folder of the workflow run it is an agent of, if it is one.
 *
 * - `<dir>/<id>/subagents/agent-<sub>.jsonl` → `<dir>/<id>.jsonl`.
 * - `<dir>/<id>/subagents/workflows/<run>/agent-<sub>.jsonl` → the same,
 *   and the run's folder.
 *
 * @returns null for a file in neither place.
 */
export function subagentPlace(
  file: string,
): { conversation: string; run: string | null } | null {
  const dir = dirname(file);
  if (basename(dir) === "subagents")
    return { conversation: `${dirname(dir)}.jsonl`, run: null };
  const workflows = dirname(dir);
  const subagents = dirname(workflows);
  if (
    basename(workflows) === "workflows" &&
    basename(subagents) === "subagents"
  )
    return { conversation: `${dirname(subagents)}.jsonl`, run: dir };
  return null;
}

/** Whether a Codex task is open: `task_started` with no end after it. */
export function codexWorking(tail: Line[]): boolean {
  return codexTurnIn(tail) ?? false;
}

/**
 * The newest Codex turn marker in `tail`: true for `task_started`, false for
 * its end, null when the lines hold none.
 */
function codexTurnIn(tail: Line[]): boolean | null {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (line.type !== "event_msg") continue;
    const kind = (line.payload as { type?: unknown } | null)?.type;
    if (kind === "task_started") return true;
    if (kind === "task_complete" || kind === "turn_aborted") return false;
  }
  return null;
}

/**
 * Codex's turn markers as a rollout writes them, each with what it says.
 *
 * NOTE: Matched as bytes. Inside a JSON string every `"` is escaped, so a
 * tool's output that quotes a marker can never match it.
 */
const CODEX_MARKERS: readonly (readonly [Buffer, boolean])[] = [
  [Buffer.from('"payload":{"type":"task_started"'), true],
  [Buffer.from('"payload":{"type":"task_complete"'), false],
  [Buffer.from('"payload":{"type":"turn_aborted"'), false],
];
/** Bytes two steps of a scan share, so a marker across them is seen. */
const MARKER_OVERLAP =
  Math.max(...CODEX_MARKERS.map(([bytes]) => bytes.length)) - 1;
/** How much of a rollout one step of the backward scan reads. */
const SCAN_STEP = 1024 * 1024;

/**
 * Per rollout, what the backward scan last found: how far the file had been
 * read, from where, and the newest marker's word (null: none at all).
 */
const codexTurns = new Map<
  string,
  { size: number; from: number; working: boolean | null }
>();
/** The most rollouts remembered; the oldest go first. */
const CODEX_TURNS_MAX = 256;

/** Remember what `file`'s turn read as, up to `size`. */
function keepCodexTurn(
  file: string,
  size: number,
  from: number,
  working: boolean | null,
) {
  codexTurns.delete(file);
  codexTurns.set(file, { size, from, working });
  if (codexTurns.size > CODEX_TURNS_MAX)
    codexTurns.delete(codexTurns.keys().next().value as string);
}

/**
 * The newest turn marker in bytes `[from, size)` of `file`, read backward
 * step by step, or null when there is none.
 */
async function codexMarkerBefore(
  file: string,
  from: number,
  size: number,
): Promise<boolean | null> {
  if (size <= from) return null;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(SCAN_STEP, size - from));
    let end = size;
    while (end > from) {
      const start = Math.max(from, end - SCAN_STEP);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const chunk = buffer.subarray(0, bytesRead);
      let newest = -1;
      let working: boolean | null = null;
      for (const [bytes, says] of CODEX_MARKERS) {
        const at = chunk.lastIndexOf(bytes);
        if (at > newest) {
          newest = at;
          working = says;
        }
      }
      if (working !== null) return working;
      if (start === from) break;
      end = start + MARKER_OVERLAP;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Whether a Codex rollout's turn is open, past what its last lines show.
 *
 * NOTE: {@link codexWorking} reads a {@link CHUNK} tail, and one tool output
 * (a generated image, as base64) is a line of megabytes: a turn still at work
 * then shows no marker there and read idle (FE-163). With none in `tail`, the
 * file is searched backward as bytes for the newest. What was found is kept
 * by file, so the next write only searches what was added since; a cut-off
 * turn ({@link cutOffAt}) is searched from the cut on.
 *
 * @param tail The file's last lines, as `size` bytes long, from no earlier
 *   than its cut, if it has one ({@link turnTail}).
 */
export async function codexTurnOpen(
  file: string,
  size: number,
  tail: Line[],
): Promise<boolean> {
  const from = cutOffAt(file, size) ?? 0;
  const seen = codexTurnIn(tail);
  if (seen !== null) {
    keepCodexTurn(file, size, from, seen);
    return seen;
  }
  const kept = codexTurns.get(file);
  // Kept for this file as it is now: shorter, or another cut, is read anew.
  const usable = kept && kept.from === from && kept.size <= size;
  const lo = usable ? Math.max(from, kept.size - MARKER_OVERLAP) : from;
  const found = await codexMarkerBefore(file, lo, size);
  const working = found ?? (usable ? kept.working : null);
  keepCodexTurn(file, size, from, working);
  return working ?? false;
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
 * NOTE: `known` is the file's mtime and its last {@link CHUNK} as lines, for
 * a caller that has just read them through the ingest's shared tail cache
 * (`tailReadOf`): the file is then neither stat'ed nor read again. The lines
 * are only read here, never reordered, as the cache hands out the same array
 * to every asker.
 *
 * @param known The file's mtime and last lines, when the caller has them.
 * @returns false for an interruption, a missing file or a stale run.
 */
export async function transcriptCompleted(
  file: string,
  agent: "claude" | "codex",
  known?: { mtimeMs: number; tail: Line[] },
): Promise<boolean> {
  try {
    const info = known ? undefined : await stat(file);
    // NOTE: Stale is told before any read, as it always was.
    if (Date.now() - (known?.mtimeMs ?? info?.mtimeMs ?? 0) > STALE_MS)
      return false;
    const start = Math.max(0, (info?.size ?? 0) - CHUNK);
    const held =
      known?.tail ??
      lines(await readRange(file, start, CHUNK), { head: start === 0 });
    const tail = [...held];
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
 * Transcripts whose last turn was cut off with the process writing it (a
 * crash, a kill after an unanswered Stop), by file: its size when it ended.
 *
 * NOTE: A CLI that dies mid-turn never writes the turn's end, and every read
 * of "working" walks back to that open turn. Only what was written AFTER the
 * cut decides instead, so the record covers the cut turn alone: the next
 * prompt lands after it and reads as working again. In memory only: the
 * engines that cut turns off end with the app, and after a restart the
 * {@link STALE_MS} rule takes over as before.
 */
const cuts = new Map<string, number>();

/** The most cut-off transcripts remembered; the oldest go first. */
const CUTS_MAX = 256;

/** Told each time a transcript's turn is recorded as cut off. */
const cutListeners = new Set<(file: string) => void>();

/**
 * Where `file`'s last turn was cut off, if it was and `size` is past it.
 *
 * @returns The byte the cut was at, or null. A file now shorter was
 *   rewritten: its record goes.
 */
export function cutOffAt(file: string, size: number): number | null {
  const at = cuts.get(file);
  if (at === undefined) return null;
  if (size < at) {
    cuts.delete(file);
    return null;
  }
  return at;
}

/**
 * The end of `file` that says whether its agent works: its last
 * {@link CHUNK}, from no earlier than a cut-off turn (see {@link cutOffAt}).
 */
export async function turnTail(file: string, size: number): Promise<Line[]> {
  const cut = cutOffAt(file, size);
  const start = Math.max(0, size - CHUNK, cut ?? 0);
  return lines(await readRange(file, start, CHUNK), {
    head: start === 0 || start === cut,
  });
}

/**
 * Record that `file`'s turn ended with its process, if its transcript still
 * reads as working, and tell the watchers so.
 *
 * Called on every exit of an engine's process: a turn that ended properly
 * reads idle and records nothing.
 *
 * @returns Whether a cut was recorded.
 */
export async function markTurnCut(
  file: string,
  agent: "claude" | "codex",
): Promise<boolean> {
  try {
    const { size } = await stat(file);
    const tail = await turnTail(file, size);
    const working =
      agent === "codex"
        ? await codexTurnOpen(file, size, tail)
        : claudeWorking(tail);
    if (!working) return false;
    cuts.delete(file);
    cuts.set(file, size);
    if (cuts.size > CUTS_MAX) cuts.delete(cuts.keys().next().value as string);
  } catch {
    return false;
  }
  for (const listener of cutListeners) {
    try {
      listener(file);
    } catch {
      // One listener's failure never keeps the others from hearing.
    }
  }
  return true;
}

/**
 * Hear each transcript whose turn {@link markTurnCut} records as cut off.
 *
 * @returns The function that stops listening.
 */
export function onTurnCut(listener: (file: string) => void): () => void {
  cutListeners.add(listener);
  return () => cutListeners.delete(listener);
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
    // A Claude sub-agent has its own check, and its own staleness.
    if (agent === "claude" && subagent) return await claudeSubagentGoing(file);
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > STALE_MS) return false;
    const tail = await turnTail(file, info.size);
    return agent === "codex"
      ? await codexTurnOpen(file, info.size, tail)
      : claudeWorking(tail);
  } catch {
    return false;
  }
}

/**
 * How long a BACKGROUND sub-agent's own file may sit still and it still be
 * going (FE-100/S2).
 *
 * NOTE: Not its conversation's silence: a conversation waits on its
 * background agents without a word, for as long as they take.
 */
export const SUBAGENT_STALE_MS = 60 * 60_000;

/**
 * How much later than its own last word an end may be said and still be the
 * end of THAT run. A background sub-agent can be sent more work after it
 * ended, and then is going again.
 */
const END_SLACK_MS = 2_000;

/** The most of a sub-agent's `.meta.json` one read takes. */
const META_MAX = 64 * 1024;

/**
 * What a Claude sub-agent's `.meta.json` says of how it was started: the
 * call that spawned it, and whether in the background.
 */
export interface SubagentMeta {
  toolUseId: string | null;
  background: boolean;
}

/** {@link SubagentMeta} read straight from the file, uncached. */
async function subagentMeta(file: string): Promise<SubagentMeta> {
  const meta = record(
    await readRange(file.replace(/\.jsonl$/, ".meta.json"), 0, META_MAX)
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null),
  );
  return {
    toolUseId: typeof meta?.toolUseId === "string" ? meta.toolUseId : null,
    background: meta?.requestShape === "background",
  };
}

/** When a sub-agent last said anything, epoch ms: its newest turn's time. */
function lastWord(tail: Line[], fallback: number): number {
  for (let at = tail.length - 1; at >= 0; at--) {
    const line = tail[at] as Line;
    if (line.type !== "user" && line.type !== "assistant") continue;
    const stamp =
      typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(stamp)) return stamp;
  }
  return fallback;
}

/**
 * Whether a Claude sub-agent is still going (FE-100/S4): the one check the
 * rail, the capsules, the workflow runs and the sub-agent viewer share.
 *
 * - Its own newest word is not a finished answer
 *   ({@link claudeSubagentWorking}).
 * - Its conversation has not said it ended since that word
 *   ({@link claudeSubagentEnds}); a workflow's agent, its run's journal has
 *   no result from it.
 * - Its own file was written within {@link STALE_MS}, or within
 *   {@link SUBAGENT_STALE_MS} for one started in the background or by a
 *   workflow.
 *
 * NOTE: A workflow run that ended ends its agents too. That is the run's
 * status, which its caller has: this does not read it.
 *
 * NOTE: `known` lets a caller that already holds what this reads hand it
 * over: the file's mtime and last lines from the ingest's shared tail cache
 * (`tailReadOf`), and `meta` from its sub-agent cache (`subagentLook`). `meta`
 * is a function so that it is only asked for where the file is read here:
 * never for a workflow's agent. Without them this reads them itself.
 *
 * @param known Its file's mtime and last lines, and how it was started, when
 *   the caller has them.
 */
export async function claudeSubagentGoing(
  file: string,
  known?: {
    mtimeMs: number;
    tail: Line[];
    meta?: () => Promise<SubagentMeta>;
  },
): Promise<boolean> {
  try {
    let mtimeMs = known?.mtimeMs;
    let tail = known?.tail;
    if (mtimeMs === undefined || tail === undefined) {
      const info = await stat(file);
      mtimeMs = info.mtimeMs;
      const start = Math.max(0, info.size - CHUNK);
      tail = lines(await readRange(file, start, CHUNK), { head: start === 0 });
    }
    const age = Date.now() - mtimeMs;
    if (age > SUBAGENT_STALE_MS || !claudeSubagentWorking(tail)) return false;
    const sub = CLAUDE_SUBAGENT_FILE.exec(basename(file))?.[1];
    const place = subagentPlace(file);
    if (!sub || !place) return age <= STALE_MS;
    if (place.run) return !(await readJournal(place.run)).results.has(sub);
    const [meta, ends] = await Promise.all([
      known?.meta ? known.meta() : subagentMeta(file),
      claudeSubagentEnds(place.conversation),
    ]);
    if (!meta.background && !ends.background.has(sub) && age > STALE_MS)
      return false;
    const ended = Math.max(
      ends.agents.get(sub) ?? Number.NEGATIVE_INFINITY,
      (meta.toolUseId ? ends.calls.get(meta.toolUseId) : undefined) ??
        Number.NEGATIVE_INFINITY,
    );
    return ended + END_SLACK_MS < lastWord(tail, mtimeMs);
  } catch {
    return false;
  }
}
