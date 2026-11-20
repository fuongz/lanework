// A Codex conversation read as a chat: its rollout's lines folded into the
// same turns a Claude transcript gives (`transcript.ts`). That is the prompt,
// then the answer's text and its tool calls, with per-turn usage.
//
// Codex writes every finished item of a turn as an `event_msg` of type
// `item_completed` (`UserMessage`, `AgentMessage`, `CommandExecution`,
// `FileChange`, `McpToolCall`…), which is what is read here. Older CLIs wrote
// `user_message` / `agent_message` events instead; those are read as text.
//
// Read-only, and nothing here imports Electron: main calls it, and a Node
// script can drive it against a fake home folder.
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type AssistantTurn,
  type Attachment,
  CONVERSATION_READ_MAX,
  type Conversation,
  type ConversationFacts,
  isLaneworkEnvelope,
  spanMs,
  type ToolCall,
  type Turn,
  type TurnUsage,
  type UserTurn,
} from "../../../shared/conversation";
import type { TeamLead } from "../../../shared/orchestration";
import { type AgentCard, isAgentSessionId } from "../../../shared/terminal";
import {
  codexRole,
  codexRollouts,
  codexWorking,
  type Line,
  laneworkCard,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "../terminal/agent-sessions";
import {
  cut,
  type FoldKind,
  foldedFacts,
  inputText,
  latestFoldedProposal,
  type RowFold,
  readFolded,
} from "./transcript";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** A path or a file URL as a path: `file:///a/b` → `/a/b`. */
function pathOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  if (!text.startsWith("file://")) return text;
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    return null;
  }
}

/** A path as the row shows it: under `folder`, relative to it. */
function shown(path: string, folder: string): string {
  const rel = relative(folder, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/**
 * A command as one line.
 *
 * A shell wrapper gives its script: `["/bin/zsh", "-lc", "ls"]` → `ls`. Any
 * other shape is joined.
 */
function commandLine(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter(
    (part): part is string => typeof part === "string",
  );
  if (parts.length === 3 && /^-l?c$/.test(parts[1] ?? ""))
    return parts[2] ?? "";
  return parts.join(" ");
}

/** A message item's text parts, joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** A finished tool item as a call, or null for one with nothing to show. */
function toolOf(
  item: Record<string, unknown>,
  folder: string,
  fallback: string,
): ToolCall | null {
  const id = str(item.id) ?? fallback;
  const base = {
    id,
    error: false,
    filePath: null,
    subagent: null,
    startedAt: null,
    durationMs: null,
  };
  switch (item.type) {
    case "CommandExecution": {
      const command = commandLine(item.command);
      return {
        ...base,
        tool: "exec_command",
        kind: "command",
        summary: tidy(command),
        input: cut(command),
        output: cut(str(item.aggregated_output) ?? ""),
        error:
          item.status === "failed" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0),
      };
    }
    case "FileChange": {
      const changes = record(item.changes);
      const paths = Object.keys(changes);
      const diff = paths
        .map((path) => {
          const change = record(changes[path]);
          const body = str(change.unified_diff) ?? str(change.content) ?? "";
          return `${str(change.type) ?? "update"} ${shown(path, folder)}\n${body}`;
        })
        .join("\n\n");
      return {
        ...base,
        tool: "apply_patch",
        kind: "edit",
        summary: tidy(paths.map((path) => shown(path, folder)).join(", ")),
        input: cut(diff),
        output: cut(
          [str(item.stdout), str(item.stderr)].filter(Boolean).join("\n"),
        ),
        error: item.status === "failed",
        filePath: paths[0] ?? null,
      };
    }
    case "McpToolCall": {
      const server = str(item.server) ?? "mcp";
      const tool = str(item.tool) ?? "tool";
      const result = record(item.result);
      const output =
        textOf(result.content) || (item.error ? inputText(item.error) : "");
      return {
        ...base,
        tool: `mcp__${server}__${tool}`,
        kind: "mcp",
        summary: tidy(`${server}: ${tool}`),
        input: inputText(item.arguments),
        output: cut(output),
        error: item.status === "failed" || Boolean(item.error),
      };
    }
    case "WebSearch": {
      const query = str(item.query) ?? "";
      return {
        ...base,
        tool: "web_search",
        kind: "search",
        summary: tidy(query),
        input: cut(query),
        output: "",
      };
    }
    case "ImageView": {
      const path = pathOf(item.path);
      if (!path) return null;
      return {
        ...base,
        tool: "view_image",
        kind: "read",
        summary: tidy(shown(path, folder)),
        input: cut(path),
        output: "",
        filePath: path,
      };
    }
    case "Extension": {
      // NOTE: An image generation carries the image itself, base64, in
      // `result`: only its prompt and saved path are read.
      const prompt = str(item.revisedPrompt) ?? str(item.kind) ?? "extension";
      const saved = str(item.savedPath);
      return {
        ...base,
        tool: str(item.kind) ?? "extension",
        kind: "other",
        summary: tidy(prompt),
        input: cut(prompt),
        output: saved ?? "",
        error: item.status === "failed",
        filePath: saved,
      };
    }
    default:
      return null;
  }
}

/** An item's own `duration` (`{ secs, nanos }`) in ms, when it has one. */
function itemMs(item: Record<string, unknown>): number | null {
  const duration = record(item.duration);
  const secs = duration.secs;
  const nanos = duration.nanos;
  if (typeof secs !== "number" || !Number.isFinite(secs)) return null;
  const ms = secs * 1000 + (typeof nanos === "number" ? nanos / 1e6 : 0);
  // A span past what a `Date` holds is no duration at all.
  return ms >= 0 && ms <= 8.64e15 ? Math.round(ms) : null;
}

/** A model's tool call not yet answered: when it was issued, in ms. */
interface OpenCall {
  at: number;
  /** When the last item finished inside it, items running one by one. */
  lastItemAt: number | null;
}

/**
 * When a finished item started, and how long it took.
 *
 * Codex writes only the finished item, at `at`. A command or MCP call
 * carries its own `duration`: it started that long before. Any other item
 * (a patch, an image, a search) ran inside the model's newest tool call
 * still unanswered: it started with that call, or with the item before it
 * there. With neither, its time is unknown.
 */
function timingOf(
  item: Record<string, unknown>,
  at: string,
  open: Map<string, OpenCall>,
): Pick<ToolCall, "startedAt" | "durationMs"> {
  const end = Date.parse(at);
  if (!Number.isFinite(end)) return { startedAt: null, durationMs: null };
  const own = itemMs(item);
  const call = [...open.values()].at(-1);
  const from = call ? Math.max(call.at, call.lastItemAt ?? call.at) : null;
  if (call) call.lastItemAt = end;
  if (own !== null)
    return { startedAt: new Date(end - own).toISOString(), durationMs: own };
  if (from === null) return { startedAt: null, durationMs: null };
  return {
    startedAt: new Date(from).toISOString(),
    durationMs: spanMs(from, end),
  };
}

/** A `UserMessage` item's text and attached images. */
function promptOf(item: Record<string, unknown>): {
  text: string;
  attachments: Attachment[];
} {
  const content = Array.isArray(item.content)
    ? (item.content as Record<string, unknown>[])
    : [];
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string")
      texts.push(part.text);
    else if (part?.type === "local_image" || part?.type === "image") {
      const path = pathOf(part.path);
      attachments.push({
        name: path?.split("/").pop() || `Image #${attachments.length + 1}`,
        mediaType: "image/*",
        path: path && path !== "-" ? path : null,
      });
    }
  }
  return { text: texts.join("\n\n").trim(), attachments };
}

/**
 * One builder of a rollout's turns, a line at a time.
 *
 * A user turn per prompt, and everything after it (text, tool calls folded
 * between two texts) as one assistant turn. Usage is summed from its
 * `token_count` events.
 *
 * @param legacy Read the old `user_message` / `agent_message` events as
 *   text: right for a rollout with no item events, wrong for one with them
 *   (see {@link codexRows}).
 */
function turnBuilder(folder: string, legacy: boolean) {
  const turns: Turn[] = [];
  let building: AssistantTurn | null = null;
  let usage = { input: 0, output: 0, cached: 0, seen: false };
  let promptAt: number | null = null;
  let model: string | null = null;
  // The model's tool calls not yet answered, by call id, oldest first.
  const calls = new Map<string, OpenCall>();

  /** The usage of the turn being built, or null when no count came. */
  const finishUsage = (): TurnUsage | null => {
    if (!usage.seen) return null;
    const from = promptAt;
    const to = building?.endedAt ? Date.parse(building.endedAt) : Number.NaN;
    const seconds =
      from !== null && Number.isFinite(to) ? (to - from) / 1000 : 0;
    return {
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      cacheHitPct:
        usage.cached > 0
          ? (usage.cached / (usage.cached + usage.input)) * 100
          : null,
      tokPerSec:
        seconds > 0 && usage.output > 0 ? usage.output / seconds : null,
    };
  };
  const close = () => {
    if (!building) return;
    building.usage = finishUsage();
    if (building.blocks.length > 0 || building.usage) turns.push(building);
    building = null;
    usage = { input: 0, output: 0, cached: 0, seen: false };
  };
  const open = (id: string, at: string): AssistantTurn => {
    building ??= {
      role: "assistant",
      id,
      blocks: [],
      model,
      usage: null,
      at,
      endedAt: null,
      open: false,
    };
    return building;
  };
  const prompt = (
    id: string,
    text: string,
    attachments: Attachment[],
    at: string,
  ) => {
    if (!text && attachments.length === 0) return;
    close();
    const sent = Date.parse(at);
    promptAt = Number.isFinite(sent) ? sent : null;
    turns.push({ role: "user", id, text, attachments, at } satisfies UserTurn);
  };
  const say = (id: string, text: string, at: string) => {
    if (!text.trim()) return;
    const turn = open(id, at);
    turn.blocks.push({ type: "text", text });
    turn.endedAt = at;
  };

  return {
    /** `index`: the line's place among the lines of the fold, from 0. */
    push(line: Line, index: number) {
      const at = str(line.timestamp) ?? "";
      const payload = record(line.payload);
      if (line.type === "turn_context") {
        model = str(payload.model) ?? model;
        if (building) (building as AssistantTurn).model ??= model;
        return;
      }
      if (line.type === "response_item") {
        const callId = str(payload.call_id);
        if (!callId) return;
        if (
          payload.type === "custom_tool_call" ||
          payload.type === "function_call"
        ) {
          const issued = Date.parse(at);
          if (Number.isFinite(issued))
            calls.set(callId, { at: issued, lastItemAt: null });
        } else if (
          payload.type === "custom_tool_call_output" ||
          payload.type === "function_call_output"
        )
          calls.delete(callId);
        return;
      }
      if (line.type !== "event_msg") return;
      switch (payload.type) {
        case "item_completed": {
          const item = record(payload.item);
          const id = str(item.id) ?? `i-${index}`;
          if (item.type === "UserMessage") {
            const { text, attachments } = promptOf(item);
            prompt(id, text, attachments, at);
          } else if (item.type === "AgentMessage")
            say(id, textOf(item.content), at);
          else {
            const call = toolOf(item, folder, id);
            if (!call) break;
            Object.assign(call, timingOf(item, at, calls));
            const turn = open(id, at);
            const last = turn.blocks.at(-1);
            if (last?.type === "tools") last.calls.push(call);
            else turn.blocks.push({ type: "tools", calls: [call] });
            turn.endedAt = at;
          }
          break;
        }
        case "user_message":
          if (legacy) {
            const text = (str(payload.message) ?? "").trim();
            // Lanework's own envelopes (FE-87) are turns; Codex's tags are not.
            if (!text.startsWith("<") || isLaneworkEnvelope(text))
              prompt(`u-${index}`, text, [], at);
          }
          break;
        case "agent_message":
          if (legacy) say(`a-${index}`, str(payload.message) ?? "", at);
          break;
        case "token_count": {
          const last = record(record(payload.info).last_token_usage);
          if (!building || !Object.keys(last).length) break;
          const cached = num(last.cached_input_tokens);
          usage = {
            // NOTE: OpenAI's `input_tokens` counts the cached ones too.
            input: usage.input + Math.max(0, num(last.input_tokens) - cached),
            output: usage.output + num(last.output_tokens),
            cached: usage.cached + cached,
            seen: true,
          };
          break;
        }
        case "task_complete":
        case "turn_aborted":
          // A call the turn left unanswered times nothing after it.
          calls.clear();
          if (building) (building as AssistantTurn).endedAt = at;
          break;
      }
    },
    /** What `finish` would answer, the turn being built left open. */
    peek(): Turn[] {
      if (!building) return turns;
      const b = building as AssistantTurn;
      const usage = finishUsage();
      return b.blocks.length > 0 || usage ? [...turns, { ...b, usage }] : turns;
    },
    finish(): Turn[] {
      close();
      return turns;
    },
  };
}

/**
 * A rollout's lines folded into turns and the facts beside them, one line at
 * a time: `refreshFold` (`transcript.ts`) folds in only the lines written
 * since its last read.
 *
 * NOTE: Newer CLIs write both the item and the old event for one message, so
 * the items win wherever there are any. That is a fact about the whole
 * rollout, known only once its first item is read, and the lines before it
 * have been read by then. So until one comes the fold keeps two builders, one
 * that reads the old events as text and one that does not; the first item
 * drops the first, and an item that never comes leaves it the answer. A
 * rollout is one or the other from its start, so the second builder is idle
 * for the old and the first is dropped at once for the new.
 *
 * `index` counts every line (the fallback of an id with none), `session_meta`
 * the first one's `cwd` and branch, and the Lanework card the newest one.
 */
function codexRows(folder: string): RowFold {
  let legacy: ReturnType<typeof turnBuilder> | null = turnBuilder(folder, true);
  const items = turnBuilder(folder, false);
  let index = 0;
  let working = false;
  let meta: Record<string, unknown> | null = null;
  let card: AgentCard | null = null;
  return {
    push: (line) => {
      const payload = record(line.payload);
      if (line.type === "event_msg") {
        if (payload.type === "item_completed") legacy = null;
        // What `codexWorking` reads: the last of these decides.
        if (payload.type === "task_started") working = true;
        else if (
          payload.type === "task_complete" ||
          payload.type === "turn_aborted"
        )
          working = false;
      }
      if (line.type === "session_meta") meta ??= payload;
      card = laneworkCard(line) ?? card;
      legacy?.push(line, index);
      items.push(line, index);
      index++;
    },
    // No sub-agent transcripts: no result is read back from a place.
    longResult: () => undefined,
    peek: () => (legacy ?? items).peek(),
    finish: () => (legacy ?? items).finish(),
    facts: () => ({
      working,
      cwd: str(meta?.cwd),
      branch: str(record(meta?.git).branch),
      card,
    }),
  };
}

/**
 * The turns of a rollout's lines, in order: {@link codexRows}, all at once.
 */
export function buildCodexTurns(rows: readonly Line[], folder: string): Turn[] {
  const fold = codexRows(folder);
  for (const row of rows) fold.push(row);
  return fold.finish();
}

/** The `session_meta` at a rollout's head: it names the folder and branch. */
async function codexHead(file: string): Promise<Line | null> {
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true,
  });
  return head.find((line) => line.type === "session_meta") ?? null;
}

/**
 * How a rollout is folded for `refreshFold`.
 *
 * NOTE: The same size-and-mtime cache as a Claude transcript's: unchanged,
 * nothing is read; grown, only the new whole lines are parsed; shrunk or
 * rewritten, folded again. Past the read limit only the end is folded, and
 * the head's `session_meta` is given the fold first (`head`).
 */
const codex: FoldKind = {
  agent: "codex",
  make: codexRows,
  head: codexHead,
  working: codexWorking,
};

/** Rollout paths already found, by id, so the tree is walked once for each. */
const found = new Map<string, string>();

/**
 * The rollout of Codex conversation `id`, if it is `folder`'s own; else null.
 *
 * It is when its `session_meta` names that folder and it is somebody's
 * conversation, not a thread Codex spawned for itself.
 *
 * NOTE: The id must pass {@link isAgentSessionId}, and only files under
 * Codex's own `sessions` tree are ever opened.
 */
export async function codexRolloutPath(
  home: string,
  folder: string,
  id: string,
): Promise<string | null> {
  if (!isAgentSessionId(id)) return null;
  let file = found.get(id) ?? null;
  if (file && !(await stat(file).catch(() => null))?.isFile()) {
    found.delete(id);
    file = null;
  }
  if (!file) {
    const all = await codexRollouts(join(home, ".codex", "sessions"));
    file = all.find((path) => path.endsWith(`-${id}.jsonl`)) ?? null;
    if (!file) return null;
  }
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true,
  });
  const meta = record(
    head.find((line) => line.type === "session_meta")?.payload,
  );
  if (meta.id !== id || meta.cwd !== folder) return null;
  if (codexRole(meta).kind !== "conversation") return null;
  found.set(id, file);
  return file;
}

/**
 * Codex conversation `id` of `folder`, read for the chat.
 *
 * Past {@link CONVERSATION_READ_MAX} only the end is read, and `truncated`
 * says so; its `session_meta` is then read from the head on its own.
 *
 * Folded once and kept, as a Claude transcript is (`readFolded`): a read
 * after the rollout grew parses only the lines written since.
 *
 * @throws When the conversation has no transcript.
 */
export async function readCodexConversation(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<Conversation> {
  return readFolded(await rolloutOf(home, folder, id), folder, id, max, codex);
}

/**
 * The id of Codex conversation `id`'s latest proposal when it waits on the
 * user, or null: {@link latestClaudeProposal}, for a rollout.
 *
 * @throws When the conversation has no transcript.
 */
export async function latestCodexProposal(
  home: string,
  folder: string,
  id: string,
  leads: readonly TeamLead[],
  max = CONVERSATION_READ_MAX,
): Promise<string | null> {
  return latestFoldedProposal(
    await rolloutOf(home, folder, id),
    folder,
    leads,
    max,
    codex,
  );
}

/**
 * Small facts of Codex conversation `id`, from the same fold.
 *
 * @throws When the conversation has no transcript.
 */
export async function codexFacts(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<ConversationFacts> {
  return foldedFacts(await rolloutOf(home, folder, id), folder, max, codex);
}

/** The rollout of `id`, or the error a conversation with none gives. */
async function rolloutOf(
  home: string,
  folder: string,
  id: string,
): Promise<string> {
  const file = await codexRolloutPath(home, folder, id);
  if (!file) throw new Error("That conversation has no transcript.");
  return file;
}
