// An OpenCode conversation read as a chat (FE-104): its messages folded into
// the same turns a Claude transcript gives (`transcript.ts`). That is the
// prompt, then the answer's text and its tool calls, with per-turn usage.
//
// OpenCode v2 keeps every session of the machine in one SQLite file
// (`opencode.db`): `session_v2` for the session, `session_message` for its
// messages in order (`seq`), each one JSON row of a `type`. A `user` row is a
// prompt; each `assistant` row is one step of the answer, its `content` the
// step's text, reasoning and tool calls; an `idle` row ends the answer.
//
// Read-only, and nothing here imports Electron: main calls it, and a Node
// script can drive it against a copy of the database. The live engine draws
// its running turn with the same pieces (`opencodeToolCall`, `turnUsage`).
//
// NOTE: `node:sqlite` is loaded HERE, not at the top, as in
// `terminal/opencode-sessions.ts`: a runtime without it costs OpenCode's
// conversations, not main's start. The id reaches the query as a bound value
// after `isAgentSessionIdOf`, never as SQL.
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AssistantTurn,
  Attachment,
  Block,
  Conversation,
  ToolCall,
  ToolKind,
  Turn,
  TurnUsage,
} from "../../../shared/conversation";
import { isAgentSessionIdOf } from "../../../shared/terminal";
import { tidy } from "../transcripts/jsonl";
import { cut, inputText } from "./transcript";

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** How long a session with no `idle` after its last prompt counts as working. */
const WORKING_MS = 10 * 60_000;
/** The most messages one read takes; past it the start is dropped. */
const MESSAGES_MAX = 4_000;

/** A tool's name as OpenCode calls it, as the chat draws it (FE-62/D6). */
export function opencodeToolKind(tool: string): ToolKind {
  switch (tool.toLowerCase()) {
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
    case "multiedit":
      return "edit";
    case "bash":
    case "shell":
      return "command";
    case "read":
      return "read";
    case "grep":
    case "glob":
    case "list":
    case "ls":
    case "codesearch":
    case "websearch":
      return "search";
    case "webfetch":
    case "fetch":
      return "fetch";
    case "task":
    case "agent":
    case "subagent":
      return "agent";
    default:
      return "other";
  }
}

/** A path as the row shows it: under `folder`, relative to it. */
function shown(path: string, folder: string): string {
  const rel = relative(folder, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** A tool result's text: a string, or its text parts joined. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((part) => {
      const p = record(part);
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/** An OpenCode error's message: a string, or `{ message }` in some shape. */
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const v = record(value);
  return (
    str(v.message) ??
    str(record(v.data).message) ??
    str(record(v.error).message) ??
    ""
  );
}

/**
 * One tool call of an assistant step, as the chat draws it.
 *
 * `part` is OpenCode's: `{ id, name, state: { status, input, content,
 * metadata, error } }`. A call still running has no output yet.
 */
export function opencodeToolCall(part: Json, folder: string): ToolCall {
  const tool = str(part.name) ?? str(part.tool) ?? "tool";
  const state = record(part.state);
  const input = record(state.input);
  const kind = opencodeToolKind(tool);
  const status = str(state.status) ?? "running";
  const file = str(input.filePath) ?? str(input.path) ?? str(input.file);
  const filePath =
    file && kind !== "search" && kind !== "command"
      ? isAbsolute(file)
        ? file
        : join(folder, file)
      : null;
  const summary =
    str(input.description) && kind === "agent"
      ? (str(input.description) as string)
      : (str(input.command) ??
        (filePath ? shown(filePath, folder) : null) ??
        str(input.pattern) ??
        str(input.query) ??
        str(input.url) ??
        str(input.description) ??
        tool);
  const failed = status === "error" || status === "failed";
  const done =
    failed ||
    status === "completed" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted";
  const output = done
    ? contentText(state.content) ||
      str(record(state.metadata).output) ||
      (failed ? errorText(state.error) : "") ||
      str(state.output) ||
      ""
    : null;
  return {
    id: str(part.id) ?? str(part.callID) ?? "",
    tool,
    kind,
    summary: tidy(summary.split("\n")[0] ?? ""),
    input: inputText(state.input ?? {}),
    output: output === null ? null : cut(output),
    error: failed,
    filePath,
    subagent: null,
  };
}

/** One step's token counts, as OpenCode keeps them. */
export interface StepTokens {
  input: number;
  output: number;
  cached: number;
}

/** `tokens` of an assistant step or a `session.step.ended` event. */
export function stepTokens(value: unknown): StepTokens | null {
  const tokens = record(value);
  if (!Object.keys(tokens).length) return null;
  const cache = record(tokens.cache);
  return {
    input: num(tokens.input) + num(cache.write),
    output: num(tokens.output) + num(tokens.reasoning),
    cached: num(cache.read),
  };
}

/**
 * A turn's usage: its steps' counts summed, with its cache hit rate and
 * speed over `seconds`.
 *
 * @returns null when no step carried tokens.
 */
export function turnUsage(
  steps: Iterable<StepTokens>,
  seconds: number,
): TurnUsage | null {
  let input = 0;
  let output = 0;
  let cached = 0;
  let any = false;
  for (const step of steps) {
    any = true;
    input += step.input;
    output += step.output;
    cached += step.cached;
  }
  if (!any) return null;
  return {
    input,
    output,
    cached,
    cacheHitPct:
      cached + input > 0 && cached > 0
        ? (cached / (cached + input)) * 100
        : null,
    tokPerSec: seconds > 0 && output > 0 ? output / seconds : null,
  };
}

/** A user message's files, as the chat lists them. */
function attachmentsOf(files: unknown): Attachment[] {
  if (!Array.isArray(files)) return [];
  return (files as unknown[]).slice(0, 20).map((entry) => {
    const file = record(entry);
    const uri = str(file.uri) ?? str(file.url);
    let path: string | null = null;
    if (uri?.startsWith("file://"))
      try {
        path = decodeURIComponent(new URL(uri).pathname);
      } catch {
        path = null;
      }
    return {
      name: (str(file.name) ?? (path ? basename(path) : "file")).slice(0, 200),
      mediaType: str(file.mime) ?? "application/octet-stream",
      path,
    };
  });
}

/** `model` of a step: `{ providerID, id }` as `provider/model`. */
export function modelName(value: unknown): string | null {
  const model = record(value);
  const provider = str(model.providerID);
  const id = str(model.id);
  if (!provider || !id) return null;
  return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

/** An ISO time from epoch ms. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** One row of `session_message`, its JSON parsed. */
export interface OpenCodeMessage {
  id: string;
  type: string;
  /** Epoch ms. */
  created: number;
  data: Json;
}

/** An assistant turn being built, with what it needs before it is whole. */
interface Building {
  turn: AssistantTurn;
  steps: StepTokens[];
  firstAt: number;
  lastAt: number;
}

/**
 * The turns of a session's messages, in order.
 *
 * - A user turn is each `user` message.
 * - Every `assistant` message (one step) up to the next prompt is ONE
 *   assistant turn: its text in order, and every run of tool calls between
 *   two texts folded into one group. Reasoning is not drawn.
 * - `synthetic`, `system`, `compaction` and the switches are OpenCode's own
 *   bookkeeping, never drawn.
 */
export function buildOpenCodeTurns(
  messages: readonly OpenCodeMessage[],
  folder: string,
): Turn[] {
  const turns: Turn[] = [];
  let building: Building | null = null;
  const close = () => {
    if (!building) return;
    const seconds = (building.lastAt - building.firstAt) / 1000;
    building.turn.usage = turnUsage(building.steps, seconds);
    building.turn.endedAt = iso(building.lastAt);
    building = null;
  };
  for (const message of messages) {
    const { data } = message;
    if (message.type === "user") {
      close();
      turns.push({
        role: "user",
        id: message.id,
        text: str(data.text) ?? "",
        attachments: attachmentsOf(data.files),
        at: iso(num(record(data.time).created) || message.created),
      });
      continue;
    }
    if (message.type !== "assistant") continue;
    const time = record(data.time);
    const created = num(time.created) || message.created;
    const ended = num(time.completed) || num(time.streamed) || created;
    if (!building) {
      const turn: AssistantTurn = {
        role: "assistant",
        id: message.id,
        blocks: [],
        model: null,
        usage: null,
        at: iso(created),
        endedAt: null,
        open: false,
      };
      turns.push(turn);
      building = { turn, steps: [], firstAt: created, lastAt: ended };
    }
    const now: Building = building;
    now.lastAt = Math.max(now.lastAt, ended);
    now.turn.model = modelName(data.model) ?? now.turn.model;
    const tokens = stepTokens(data.tokens);
    if (tokens) now.steps.push(tokens);
    for (const entry of Array.isArray(data.content) ? data.content : [])
      addPart(now.turn.blocks, record(entry), folder);
    const failed = errorText(data.error);
    if (failed)
      now.turn.blocks.push({
        type: "text",
        text: `The turn failed: ${failed}`,
      });
  }
  close();
  return turns;
}

/** Add one content part of a step to `blocks`, folding tool runs. */
export function addPart(blocks: Block[], part: Json, folder: string): void {
  if (part.type === "text") {
    const text = str(part.text) ?? "";
    if (text) blocks.push({ type: "text", text });
    return;
  }
  if (part.type !== "tool") return;
  const call = opencodeToolCall(part, folder);
  const last = blocks.at(-1);
  if (last?.type === "tools") {
    const at = last.calls.findIndex((entry) => entry.id === call.id);
    if (at >= 0) last.calls[at] = call;
    else last.calls.push(call);
  } else blocks.push({ type: "tools", calls: [call] });
}

/**
 * Where OpenCode's database is, given its data folder
 * (`terminal/opencode-sessions.ts`'s `opencodeDataDir`).
 */
export const opencodeDatabase = (dataDir: string): string =>
  join(dataDir, "opencode.db");

/**
 * Whether conversation `id` is an OpenCode session of `folder`, top-level.
 *
 * @returns false for any other id, a missing database, or another folder's.
 */
export async function isOpenCodeConversation(
  dataDir: string,
  folder: string,
  id: string,
): Promise<boolean> {
  if (!isAgentSessionIdOf("opencode", id)) return false;
  return withDatabase(dataDir, (db) => {
    const row = db
      .prepare("SELECT directory FROM session_v2 WHERE id = ?")
      .get(id) as { directory?: unknown } | undefined;
    return row?.directory === folder;
  }).then((found) => found ?? false);
}

/** Open the database read-only, run `read`, close it; null on any failure. */
async function withDatabase<T>(
  dataDir: string,
  read: (db: DatabaseSync) => T,
): Promise<T | null> {
  const file = opencodeDatabase(dataDir);
  if (!(await stat(file).catch(() => null))?.isFile()) return null;
  let db: DatabaseSync | null = null;
  try {
    const driver = await import("node:sqlite");
    db = new driver.DatabaseSync(file, { readOnly: true });
    return read(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Closed already: nothing is held.
    }
  }
}

/**
 * OpenCode conversation `id` of `folder`, read for the chat.
 *
 * Past {@link MESSAGES_MAX} messages only the end is read, and `truncated`
 * says so.
 *
 * @throws When the conversation is not `folder`'s, or cannot be read.
 */
export async function readOpenCodeConversation(
  dataDir: string,
  folder: string,
  id: string,
): Promise<Conversation> {
  if (!isAgentSessionIdOf("opencode", id))
    throw new Error("A valid conversation is required");
  const read = await withDatabase(dataDir, (db) => {
    const session = db
      .prepare(
        "SELECT directory, time_updated AS updated, time_idle AS idle FROM session_v2 WHERE id = ?",
      )
      .get(id) as
      | { directory?: unknown; updated?: unknown; idle?: unknown }
      | undefined;
    if (!session || session.directory !== folder) return null;
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?")
      .get(id) as { n?: unknown } | undefined;
    const rows = db
      .prepare(
        `SELECT id, type, time_created AS created, data FROM (
           SELECT id, type, seq, time_created, data FROM session_message
            WHERE session_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`,
      )
      .all(id, MESSAGES_MAX) as unknown as {
      id: unknown;
      type: unknown;
      created: unknown;
      data: unknown;
    }[];
    return { session, total: num(total?.n), rows };
  });
  if (!read) throw new Error("That conversation has no transcript.");
  const messages: OpenCodeMessage[] = [];
  for (const row of read.rows) {
    if (typeof row.id !== "string" || typeof row.type !== "string") continue;
    let data: Json = {};
    try {
      data = record(JSON.parse(String(row.data)));
    } catch {
      continue;
    }
    messages.push({
      id: row.id,
      type: row.type,
      created: num(row.created),
      data,
    });
  }
  const turns = buildOpenCodeTurns(messages, folder);
  // Working: a prompt or a step came after the last `idle`, lately.
  let lastIdle = -1;
  let lastWork = -1;
  for (const [at, entry] of messages.entries()) {
    if (entry.type === "idle") lastIdle = at;
    else if (entry.type === "user" || entry.type === "assistant") lastWork = at;
  }
  const updated = num(read.session.updated);
  const working = lastWork > lastIdle && Date.now() - updated <= WORKING_MS;
  const last = turns.at(-1);
  if (last?.role === "assistant" && working) {
    last.open = true;
    last.endedAt = null;
  }
  return {
    id,
    agent: "opencode",
    cwd: folder,
    branch: null,
    turns,
    working,
    card: null,
    settings: null,
    truncated: read.total > MESSAGES_MAX,
  };
}
