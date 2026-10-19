// A Claude conversation read as a chat (FE-62): its transcript's lines folded
// into user turns and assistant turns — text, tool calls gathered between two
// pieces of text, per-turn usage.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a Node
// test drives it against a fake home folder, like `subagent-transcript.ts`.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssistantTurn,
  type Attachment,
  type Block,
  CONVERSATION_READ_MAX,
  type Conversation,
  TOOL_TEXT_MAX,
  type ToolCall,
  type ToolKind,
  type Turn,
  type TurnUsage,
  type UserTurn,
} from "../../../shared/conversation";
import {
  type AgentCard,
  isAgentSessionId,
  isClaudeSubagentId,
} from "../../../shared/terminal";
import {
  claudeProjectDir,
  claudeWorking,
  type Line,
  laneworkCard,
  lines,
  readRange,
  STALE_MS,
  tidy,
} from "../terminal/agent-sessions";
import { claudeStepSummary } from "../terminal/subagent-transcript";

/** Where Claude keeps conversation `id` of `folder`. */
export function transcriptPath(
  home: string,
  folder: string,
  id: string,
): string {
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  return join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${id}.jsonl`,
  );
}

/** Text cut at the most the page is sent. */
export function cut(text: string, max = TOOL_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An input as the page shows it: pretty JSON, cut short. */
export function inputText(input: unknown): string {
  if (typeof input === "string") return cut(input);
  try {
    return cut(JSON.stringify(input ?? {}, null, 2) ?? "");
  } catch {
    return "";
  }
}

/** How a tool call is drawn and counted (FE-62/D6). */
export function toolKind(tool: string): ToolKind {
  if (tool.startsWith("mcp__")) return "mcp";
  switch (tool) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "PowerShell":
      return "command";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
    case "LS":
    case "WebSearch":
      return "search";
    case "WebFetch":
      return "fetch";
    case "Task":
    case "Agent":
      return "agent";
    default:
      return "other";
  }
}

const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A tool result's content as text: a string, or its text parts. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : part?.type === "image"
          ? "[image]"
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** `<command-name>/x</command-name>…<command-args>y</command-args>` → `/x y`. */
function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
  const command = name.trim().startsWith("/") ? name.trim() : `/${name.trim()}`;
  return args?.trim() ? `${command} ${args.trim()}` : command;
}

/** What a LOCAL command — `/model`, `/cost` — answers with; never a turn. */
function localOutput(line: Line): boolean {
  if (line.type !== "user") return false;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? ((content as { type?: unknown; text?: unknown }[]).find(
            (part) => part?.type === "text",
          )?.text ?? "")
        : "";
  return (
    typeof text === "string" && text.trimStart().startsWith("<local-command-")
  );
}

/** `[Image: source: /path/to/file.png]`, what the CLI writes for a dropped image. */
const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;

const MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

function mediaOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * A user line that is somebody's prompt, read as a turn — or null: a tool
 * result, an interruption, a compaction summary, a command's output or
 * caveat, anything the CLI wrapped in a tag for itself.
 */
function promptOf(
  line: Line,
): { text: string; attachments: Attachment[]; command: boolean } | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  if (line.isCompactSummary || line.isVisibleInTranscriptOnly) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const parts: Record<string, unknown>[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? (content as Record<string, unknown>[])
        : [];
  if (parts.some((part) => part?.type === "tool_result")) return null;
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  const sources: string[] = [];
  let images = 0;
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      const source = IMAGE_SOURCE.exec(part.text.trim())?.[1];
      if (source) {
        sources.push(source.trim());
        continue;
      }
      texts.push(part.text);
    } else if (part?.type === "image" || part?.type === "document") {
      const source = record(part.source);
      const mediaType =
        typeof source.media_type === "string"
          ? source.media_type
          : part.type === "image"
            ? "image/png"
            : "application/pdf";
      images++;
      attachments.push({
        name: part.type === "image" ? `Image #${images}` : `Document`,
        mediaType,
        path: null,
      });
    }
  }
  // A dropped image's path, matched to its block in order; one without a
  // block is an attachment of its own.
  for (const [at, source] of sources.entries()) {
    const block = attachments[at];
    if (block && block.path === null) {
      block.path = source;
      block.name = source.split("/").pop() || block.name;
    } else
      attachments.push({
        name: source.split("/").pop() || source,
        mediaType: mediaOfPath(source),
        path: source,
      });
  }
  let text = texts.join("\n\n").trim();
  if (text.startsWith("[Request interrupted")) return null;
  let command = false;
  if (text.startsWith("<")) {
    const named = slashCommand(text);
    if (!named) return null;
    text = named;
    command = true;
  }
  if (!text && attachments.length === 0) return null;
  return { text, attachments, command };
}

interface Usage {
  input: number;
  output: number;
  cached: number;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function usageOf(message: Record<string, unknown>): Usage | null {
  const usage = record(message.usage);
  if (!Object.keys(usage).length) return null;
  return {
    input: num(usage.input_tokens) + num(usage.cache_creation_input_tokens),
    output: num(usage.output_tokens),
    cached: num(usage.cache_read_input_tokens),
  };
}

/** An assistant turn being built, with what it needs before it is whole. */
interface Building {
  turn: AssistantTurn;
  usage: Map<string, Usage>;
  firstAt: number | null;
  lastAt: number | null;
  /** When the prompt it answers was sent. */
  promptAt: number | null;
  lastTextMessage: string | null;
}

function finishUsage(building: Building): TurnUsage | null {
  if (building.usage.size === 0) return null;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const usage of building.usage.values()) {
    input += usage.input;
    output += usage.output;
    cached += usage.cached;
  }
  // ⚠️ The CLI writes a line per finished content block: a one-block answer
  // has one stamp, so its span is counted from the prompt instead.
  const from =
    building.firstAt !== null && building.firstAt !== building.lastAt
      ? building.firstAt
      : building.promptAt;
  const seconds =
    from !== null && building.lastAt !== null
      ? (building.lastAt - from) / 1000
      : 0;
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

const stamp = (line: Line): string | null =>
  typeof line.timestamp === "string" ? line.timestamp : null;

/**
 * The turns of a conversation's lines, in order (FE-62).
 *
 * - A user turn is a prompt somebody sent (`promptOf`).
 * - Everything between two user turns is ONE assistant turn: its text parts
 *   in order, and every run of tool calls between two texts folded into one
 *   group — across lines, each call given the result a later line brings.
 * - Usage is summed once per API message (`message.id`): the CLI writes one
 *   line per content block, each repeating its message's usage.
 */
export function buildTurns(rows: readonly Line[], folder: string): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, ToolCall>();
  let building: Building | null = null;

  const close = () => {
    if (!building) return;
    building.turn.usage = finishUsage(building);
    if (building.turn.blocks.length > 0 || building.turn.usage)
      turns.push(building.turn);
    building = null;
  };
  const open = (line: Line, at: string): Building => {
    if (building) return building;
    building = {
      turn: {
        role: "assistant",
        id: typeof line.uuid === "string" ? line.uuid : `a-${turns.length}`,
        blocks: [],
        model: null,
        usage: null,
        at,
        endedAt: null,
        open: false,
      },
      usage: new Map(),
      firstAt: null,
      lastAt: null,
      promptAt,
      lastTextMessage: null,
    };
    return building;
  };

  let promptAt: number | null = null;
  /** A slash command just read: a local one's output takes it back out. */
  let command: number | null = null;
  for (const line of rows) {
    if (line.isSidechain) continue;
    const at = stamp(line);
    if (localOutput(line) && !line.isMeta) {
      // `/model` and the like ran in the CLI and never reached the model.
      if (command !== null && command === turns.length - 1 && !building)
        turns.pop();
      command = null;
      continue;
    }
    const prompt = promptOf(line);
    if (prompt) {
      close();
      command = prompt.command ? turns.length : null;
      const sent = at ? Date.parse(at) : Number.NaN;
      promptAt = Number.isFinite(sent) ? sent : null;
      turns.push({
        role: "user",
        id: typeof line.uuid === "string" ? line.uuid : `u-${turns.length}`,
        text: prompt.text,
        attachments: prompt.attachments,
        at: at ?? "",
      } satisfies UserTurn);
      continue;
    }

    if (line.type === "assistant") {
      const message = record(line.message);
      const content = Array.isArray(message.content)
        ? (message.content as Record<string, unknown>[])
        : [];
      const turn = open(line, at ?? "");
      const time = at ? Date.parse(at) : Number.NaN;
      if (Number.isFinite(time)) {
        turn.firstAt ??= time;
        turn.lastAt = time;
      }
      if (at) turn.turn.endedAt = at;
      const model = message.model;
      if (typeof model === "string" && model && !model.startsWith("<"))
        turn.turn.model = model;
      const id = typeof message.id === "string" ? message.id : null;
      const usage = usageOf(message);
      if (id && usage) {
        // The last line of a message carries its whole count.
        const seen = turn.usage.get(id);
        turn.usage.set(
          id,
          seen
            ? {
                input: Math.max(seen.input, usage.input),
                output: Math.max(seen.output, usage.output),
                cached: Math.max(seen.cached, usage.cached),
              }
            : usage,
        );
      }
      const blocks = turn.turn.blocks;
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          if (!part.text.trim()) continue;
          const last = blocks.at(-1);
          // One message's text parts read as one piece.
          if (last?.type === "text" && id && turn.lastTextMessage === id)
            last.text = `${last.text}\n\n${part.text}`;
          else blocks.push({ type: "text", text: part.text });
          turn.lastTextMessage = id;
        } else if (part?.type === "tool_use" && typeof part.name === "string") {
          const input = record(part.input);
          const call: ToolCall = {
            id: typeof part.id === "string" ? part.id : `t-${calls.size}`,
            tool: part.name,
            kind: toolKind(part.name),
            summary: tidy(claudeStepSummary(part.name, input, folder)),
            input: inputText(part.input),
            output: null,
            error: false,
            filePath: FILE_TOOLS.has(part.name)
              ? typeof input.file_path === "string"
                ? input.file_path
                : typeof input.notebook_path === "string"
                  ? input.notebook_path
                  : null
              : null,
            subagent: null,
          };
          calls.set(call.id, call);
          const last = blocks.at(-1);
          if (last?.type === "tools") last.calls.push(call);
          else blocks.push({ type: "tools", calls: [call] });
          turn.lastTextMessage = null;
        }
      }
      continue;
    }

    if (line.type === "user") {
      // Tool results: each goes to its call.
      const content = (line.message as { content?: unknown } | undefined)
        ?.content;
      const result = record(line.toolUseResult);
      if (Array.isArray(content))
        for (const part of content as Record<string, unknown>[]) {
          if (part?.type !== "tool_result") continue;
          const call =
            typeof part.tool_use_id === "string"
              ? calls.get(part.tool_use_id)
              : undefined;
          if (!call) continue;
          call.output = cut(resultText(part.content));
          call.error = part.is_error === true;
          if (call.kind === "agent" && isClaudeSubagentId(result.agentId))
            call.subagent = result.agentId;
        }
      if (building && at) {
        const b = building as Building;
        b.turn.endedAt = at;
        const time = Date.parse(at);
        if (Number.isFinite(time)) b.lastAt = time;
      }
      continue;
    }

    // A running sub-agent names itself before its call returns.
    if (line.type === "progress") {
      const data = record(line.data);
      const parent = line.parentToolUseID;
      const call = typeof parent === "string" ? calls.get(parent) : undefined;
      if (call && call.kind === "agent" && isClaudeSubagentId(data.agentId))
        call.subagent ??= data.agentId;
      continue;
    }

    if (
      line.type === "system" &&
      line.subtype === "turn_duration" &&
      building &&
      at
    ) {
      (building as Building).turn.endedAt = at;
    }
  }
  close();
  return turns;
}

/** What a read of a transcript's lines answers, before main adds its own. */
export function conversationOf(
  id: string,
  rows: readonly Line[],
  {
    folder,
    fresh,
    truncated,
  }: { folder: string; fresh: boolean; truncated: boolean },
): Conversation {
  const turns = buildTurns(rows, folder);
  const working = fresh && claudeWorking(rows as Line[]);
  const last = turns.at(-1);
  if (last?.role === "assistant") {
    last.open = working;
    if (working) last.endedAt = null;
  }
  let cwd: string | null = null;
  let branch: string | null = null;
  let card: AgentCard | null = null;
  for (let at = rows.length - 1; at >= 0; at--) {
    const line = rows[at] as Line;
    if (cwd === null && typeof line.cwd === "string") cwd = line.cwd;
    if (branch === null && typeof line.gitBranch === "string" && line.gitBranch)
      branch = line.gitBranch;
    if (working && card === null) card = laneworkCard(line);
    if (cwd !== null && branch !== null && (card !== null || !working)) break;
  }
  return {
    id,
    agent: "claude",
    cwd,
    branch,
    turns,
    working,
    card,
    settings: null,
    truncated,
  };
}

/**
 * Conversation `id` of `folder`, read for the chat (FE-62).
 *
 * ⚠️ The path is built from the folder and an id that passed
 * `isAgentSessionId`, inside Claude's own folder under `home`. Past
 * `CONVERSATION_READ_MAX` only the end is read, and `truncated` says so.
 */
export async function readConversation(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<Conversation> {
  const file = transcriptPath(home, folder, id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error("That conversation has no transcript.");
  const fresh = Date.now() - info.mtimeMs <= STALE_MS;
  const truncated = info.size > max;
  const start = truncated ? info.size - max : 0;
  const rows = lines(await readRange(file, start, info.size - start), {
    head: !truncated,
  });
  return conversationOf(id, rows, { folder, fresh, truncated });
}

/** Re-exported for the engine's live turns. */
export type { Block, Line };
