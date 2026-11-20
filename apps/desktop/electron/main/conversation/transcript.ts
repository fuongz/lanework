// A Claude conversation read as a chat: its transcript's lines folded into
// user turns and assistant turns. An assistant turn holds its text, the tool
// calls gathered between two pieces of text, and its usage.
//
// NOTE: Read-only, and nothing here imports Electron: main calls it, and a
// Node test drives it against a fake home folder, like
// `subagent-transcript.ts`.
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssistantTurn,
  type Attachment,
  CONVERSATION_READ_MAX,
  type CompactionTurn,
  type Conversation,
  type ConversationFacts,
  isLaneworkEnvelope,
  spanMs,
  TOOL_OUTPUT_FULL_MAX,
  TOOL_TEXT_MAX,
  type ToolCall,
  type ToolKind,
  type ToolOutput,
  type Turn,
  type TurnUsage,
  type UserTurn,
  webSourcesOf,
} from "../../../shared/conversation";
import type { TeamLead } from "../../../shared/orchestration";
import { latestReadyProposal } from "../../../shared/orchestration-proposals";
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
  STALE_MS,
  tidy,
} from "../terminal/agent-sessions";
import { claudeStepSummary } from "../terminal/subagent-transcript";
import { cutOffAt, turnTail } from "../transcripts/activity";

/**
 * Where Claude keeps conversation `id` of `folder`.
 *
 * @throws When `id` is not a conversation id.
 */
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
function toolKind(tool: string): ToolKind {
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

/** The tools whose input names the one file they work on. */
const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** `value` as an object to read fields from; `{}` for anything else. */
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

/**
 * A slash command the CLI wrapped in tags, as the user typed it.
 *
 * `<command-name>/x</command-name>…<command-args>y</command-args>` reads as
 * `/x y`.
 *
 * @returns null when `text` names no command.
 */
function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
  const command = name.trim().startsWith("/") ? name.trim() : `/${name.trim()}`;
  return args?.trim() ? `${command} ${args.trim()}` : command;
}

/**
 * Whether a line is what a LOCAL command, such as `/model` or `/cost`,
 * answers with.
 *
 * Such a line is never a turn.
 */
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

/**
 * What the CLI writes for a dropped image:
 * `[Image: source: /path/to/file.png]`.
 */
const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;

/** The bytes a base64 string holds, without decoding it. */
function base64Size(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** The MIME type of each extension a dropped file may have. */
const MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/**
 * A path's MIME type by its extension.
 *
 * `application/octet-stream` when the extension is not known.
 */
function mediaOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * A message sent while a turn ran, as the user line it stands for.
 *
 * The CLI writes one it took in mid-turn as an `attachment` of type
 * `queued_command`, not as a user line (FE-67). A background task's
 * notification is one too, with another `commandMode`.
 *
 * @returns null for any other line.
 */
function steered(line: Line): Line | null {
  if (line.type !== "attachment") return null;
  const attachment = record(line.attachment);
  if (
    attachment.type !== "queued_command" ||
    attachment.commandMode !== "prompt" ||
    (typeof attachment.prompt !== "string" && !Array.isArray(attachment.prompt))
  )
    return null;
  return {
    ...line,
    type: "user",
    message: { role: "user", content: attachment.prompt },
  };
}

/**
 * A user line that is somebody's prompt, read as a turn.
 *
 * @returns null for a tool result, an interruption, a compaction summary, a
 *   command's output or caveat, and anything the CLI wrapped in a tag for
 *   itself.
 */
function promptOf(
  line: Line,
): { text: string; attachments: Attachment[]; command: boolean } | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  if (line.isCompactSummary || line.isVisibleInTranscriptOnly) return null;
  // The stream's word for the same: a meta line, a compaction summary.
  if (line.isSynthetic) return null;
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
      const data = typeof source.data === "string" ? source.data : "";
      attachments.push({
        name: part.type === "image" ? `Image #${images}` : `Document`,
        mediaType,
        path: null,
        ...(data ? { size: base64Size(data) } : {}),
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
  // Lanework's own envelopes (`/orchestrate`, FE-87) are the person's turn;
  // the chat decides what of them to draw.
  if (text.startsWith("<") && !isLaneworkEnvelope(text)) {
    const named = slashCommand(text);
    if (!named) return null;
    text = named;
    command = true;
  }
  if (!text && attachments.length === 0) return null;
  return { text, attachments, command };
}

/** One API message's token counts. */
interface Usage {
  /** Input tokens, cache writes included. */
  input: number;
  output: number;
  /** Input tokens read from the cache. */
  cached: number;
}

/** `value` when it is a finite number, else 0. */
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * An API message's token counts.
 *
 * @returns null when the message carries no usage.
 */
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
  /** By API message id, so each message is counted once. */
  usage: Map<string, Usage>;
  /** The first and last line's time, in epoch ms. */
  firstAt: number | null;
  lastAt: number | null;
  /** When the prompt it answers was sent. */
  promptAt: number | null;
  /** The API message the last text block came from. */
  lastTextMessage: string | null;
}

/**
 * A turn's usage: its messages' counts summed, with its cache hit rate and
 * speed.
 *
 * @returns null when no message of the turn carried usage.
 */
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
  // NOTE: The CLI writes a line per finished content block. A one-block
  // answer has one stamp, so its span is counted from the prompt instead.
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

/** A line's `timestamp`, when it has one. */
const stamp = (line: Line): string | null =>
  typeof line.timestamp === "string" ? line.timestamp : null;

/** `value` when it is a finite number, else null. */
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A `compact_boundary` line read as the chat's divider (FE-120).
 *
 * The transcript names its numbers `compactMetadata.preTokens`; the
 * stream-json output, `compact_metadata.pre_tokens`.
 *
 * @returns null for any other line.
 */
function compactionOf(line: Line, at: string | null): CompactionTurn | null {
  if (line.type !== "system" || line.subtype !== "compact_boundary")
    return null;
  const file = record(line.compactMetadata);
  const stream = record(line.compact_metadata);
  const trigger = file.trigger ?? stream.trigger;
  return {
    role: "compaction",
    id: typeof line.uuid === "string" ? line.uuid : `c-${at ?? ""}`,
    trigger: trigger === "manual" || trigger === "auto" ? trigger : null,
    preTokens: count(file.preTokens) ?? count(stream.pre_tokens),
    postTokens: count(file.postTokens) ?? count(stream.post_tokens),
    summary: null,
    taskId: null,
    at: at ?? "",
  };
}

/**
 * The text of the summary a compaction kept: the user line after its
 * boundary, `isCompactSummary` in the transcript, `isSynthetic` in the
 * stream.
 *
 * @returns null for any other line.
 */
function compactSummary(line: Line): string | null {
  if (line.type !== "user" || line.isSidechain) return null;
  if (!line.isCompactSummary && !line.isSynthetic) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Record<string, unknown>[])
            .map((part) =>
              part?.type === "text" && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join("\n\n")
        : "";
  return text.trim() ? cut(text.trim()) : null;
}

/**
 * The reminder Lanework's hook gives right after a compaction (FE-117), and
 * the task id in it.
 *
 * NOTE: Mirrors `compactReminder` in `electron/hook/compaction.ts`, whose
 * text is a fixed template but for the id; main bundles no hook code, so it
 * is matched here, not imported. The id pattern is the hook's own.
 */
const COMPACT_REMINDER =
  /Lanework: the context was just compacted while you were working ([A-Z][A-Z0-9]{0,9}-\d{1,6})\. Before continuing, call the lanework `checkpoint` tool for card \1\b/;

/**
 * The task id a `SessionStart` hook's reminder names.
 *
 * - Transcript: an `attachment` line, `hook_additional_context` (its
 *   `content`) or `hook_success` (its `stdout`).
 * - Stream: a `system` `hook_response` line (its `stdout` / `output`).
 *
 * @returns null for any other line, or one without Lanework's reminder.
 */
function reminderTaskId(line: Line): string | null {
  let said: unknown[] = [];
  if (line.type === "attachment") {
    const attachment = record(line.attachment);
    if (attachment.hookEvent !== "SessionStart") return null;
    said = [attachment.content, attachment.stdout];
  } else if (line.type === "system" && line.subtype === "hook_response") {
    if (line.hook_event !== "SessionStart") return null;
    said = [line.stdout, line.output];
  } else return null;
  for (const value of said) {
    const text =
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.filter((part) => typeof part === "string").join("\n")
          : "";
    // The hook's stdout is JSON: its backticks come through unescaped.
    const found = COMPACT_REMINDER.exec(text)?.[1];
    if (found) return found;
  }
  return null;
}

/**
 * The turns of a conversation's lines, in order.
 *
 * - A user turn is a prompt somebody sent ({@link promptOf}).
 * - Everything between two user turns is ONE assistant turn: its text parts
 *   in order, and every run of tool calls between two texts folded into one
 *   group — across lines, each call given the result a later line brings.
 * - Usage is summed once per API message (`message.id`): the CLI writes one
 *   line per content block, each repeating its message's usage.
 * - A `compact_boundary` is a turn of its own (FE-120), with the summary
 *   after it and the task id of Lanework's reminder. Every turn before it
 *   stays: the lines are read in file order, never by `parentUuid`, which a
 *   boundary does not have.
 */
export function turnFold(folder: string): TurnFold {
  const turns: Turn[] = [];
  const calls = new Map<string, ToolCall>();
  // Where each result longer than the page is sent lies in the file, by call.
  const long = new Map<string, LineSpan>();
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
  // The turn of a slash command just read: a local one's output takes it
  // back out.
  let command: number | null = null;
  // FE-120: the last compaction, until the model next answers; and a
  // reminder told before its boundary, as the stream tells it.
  let compacted: CompactionTurn | null = null;
  let reminded: string | null = null;
  const push = (line: Line, where?: LineSpan): void => {
    if (line.isSidechain) return;
    const at = stamp(line);
    const compaction = compactionOf(line, at);
    if (compaction) {
      // An automatic one may fall mid-answer: the answer goes on below it.
      close();
      command = null;
      compaction.taskId = reminded;
      reminded = null;
      compacted = compaction;
      turns.push(compaction);
      return;
    }
    if (compacted && compacted.summary === null && turns.at(-1) === compacted) {
      const summary = compactSummary(line);
      if (summary) {
        compacted.summary = summary;
        return;
      }
    }
    const task = reminderTaskId(line);
    if (task) {
      // The transcript writes the hook's attachment after the boundary; the
      // stream tells its `hook_response` before.
      if (line.type !== "attachment") reminded = task;
      else if (compacted && compacted.taskId === null) compacted.taskId = task;
      return;
    }
    // NOTE: A current CLI writes a local command's answer as a `system`
    // `local_command` line ("Not enough messages to compact."), and the
    // stream tells the same words as an assistant message. Read as nothing,
    // the chat showed the command and then a blank page once the transcript
    // replaced the live turn. It is the command's answer: shown as one.
    if (line.type === "system" && line.subtype === "local_command") {
      const said = localCommandText(line.content);
      if (said) {
        close();
        command = null;
        turns.push({
          role: "assistant",
          id: typeof line.uuid === "string" ? line.uuid : `a-${turns.length}`,
          blocks: [{ type: "text", text: said }],
          model: null,
          usage: null,
          at: at ?? "",
          endedAt: at,
          open: false,
        });
      }
      return;
    }
    if (localOutput(line) && !line.isMeta) {
      // `/model` and the like ran in the CLI and never reached the model.
      if (command !== null && command === turns.length - 1 && !building)
        turns.pop();
      command = null;
      return;
    }
    const prompt = promptOf(steered(line) ?? line);
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
      return;
    }

    if (line.type === "assistant") {
      // The model answers: a hook's reminder after this is not the
      // compaction's.
      compacted = null;
      reminded = null;
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
            startedAt: at,
            durationMs: null,
          };
          calls.set(call.id, call);
          const last = blocks.at(-1);
          if (last?.type === "tools") last.calls.push(call);
          else blocks.push({ type: "tools", calls: [call] });
          turn.lastTextMessage = null;
        }
      }
      return;
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
          const text = resultText(part.content);
          call.output = cut(text);
          if (text.length > TOOL_TEXT_MAX) {
            call.outputCut = true;
            if (where) long.set(call.id, where);
          }
          call.error = part.is_error === true;
          call.durationMs = spanMs(call.startedAt, at);
          if (call.kind === "agent" && isClaudeSubagentId(result.agentId))
            call.subagent = result.agentId;
        }
      if (building && at) {
        const b = building as Building;
        b.turn.endedAt = at;
        const time = Date.parse(at);
        if (Number.isFinite(time)) b.lastAt = time;
      }
      return;
    }

    // A running sub-agent names itself before its call returns.
    if (line.type === "progress") {
      const data = record(line.data);
      const parent = line.parentToolUseID;
      const call = typeof parent === "string" ? calls.get(parent) : undefined;
      if (call && call.kind === "agent" && isClaudeSubagentId(data.agentId))
        call.subagent ??= data.agentId;
      return;
    }

    if (
      line.type === "system" &&
      line.subtype === "turn_duration" &&
      building &&
      at
    ) {
      (building as Building).turn.endedAt = at;
    }
  };
  return {
    push,
    longResult: (call) => long.get(call),
    finish: () => {
      close();
      return turns;
    },
    peek: () => {
      if (!building) return turns;
      const b = building as Building;
      const usage = finishUsage(b);
      // What `close` would push, left open: the next line may add to it.
      return b.turn.blocks.length > 0 || usage
        ? [...turns, { ...b.turn, usage }]
        : turns;
    },
  };
}

/**
 * {@link buildTurns}, one line at a time, so a transcript that only grew
 * folds in its new lines alone (`refreshFold`), and the engine's running
 * turn takes each line as it comes (`emitLast`).
 */
export interface TurnFold {
  /** `where`: the line's place in its file, when it was read from one. */
  push: (line: Line, where?: LineSpan) => void;
  /**
   * Where the line holding call `call`'s result lies, when that result was
   * cut ({@link ToolCall.outputCut}) and the line came with its place.
   */
  longResult: (call: string) => LineSpan | undefined;
  /** The turns, the last one closed: the fold is done with. */
  finish: () => Turn[];
  /**
   * The turns so far, the one being built included, without closing it.
   * They are the fold's own: read them, never change them.
   */
  peek: () => Turn[];
}

/** A line's place in its file: its first byte, and its length in bytes. */
export interface LineSpan {
  at: number;
  length: number;
}

/**
 * The turns of a conversation's lines, in order: see {@link turnFold}.
 */
export function buildTurns(rows: readonly Line[], folder: string): Turn[] {
  const fold = turnFold(folder);
  for (const line of rows) fold.push(line);
  return fold.finish();
}

// ─── A transcript folded once, read by the chat and the rail ────────────────

/**
 * A Claude transcript folded into turns, kept between reads so a transcript
 * that only grew is read from where the last read stopped.
 */
interface FoldedTranscript {
  /** What the fold was started for: another folder or limit starts anew. */
  folder: string;
  max: number;
  /** The file as last read: when both still match, nothing is read. */
  size: number;
  mtimeMs: number;
  /** Where the fold started: 0, or past the read limit the tail's start. */
  start: number;
  /** Where the whole lines folded so far end: the next read's start. */
  end: number;
  /** `end` is a line's start; false until a tail's cut first line is gone. */
  aligned: boolean;
  /** The last bytes folded, up to `end` (`foldNew`). */
  seen: Buffer;
  /** The turns and facts of every line folded so far. */
  fold: RowFold;
  /** The rail's last answer and what it assumed; dropped when a line is folded. */
  answer: { working: boolean; leads: string; id: string | null } | null;
  /** The panel's last facts; dropped when a line is folded. */
  facts: ConversationFacts | null;
}

/** What the lines folded so far say beside their turns. */
export interface RowFacts {
  /** Whether the agent works, as the lines alone say (not the file's age). */
  working: boolean;
  cwd: string | null;
  branch: string | null;
  /** The newest Lanework card a line names. */
  card: AgentCard | null;
}

/** A {@link TurnFold} that also keeps what the same lines say of the session. */
export interface RowFold extends TurnFold {
  facts: () => RowFacts;
}

/**
 * One CLI's transcript, as {@link refreshFold} folds it: Claude's here,
 * Codex's in `codex-transcript.ts`. Both are JSONL, so the cache (size and
 * mtime, new complete lines only, a rewrite folded again) is one.
 */
export interface FoldKind {
  agent: "claude" | "codex";
  /** A fold with no line yet. */
  make: (folder: string) => RowFold;
  /**
   * The line a fold that starts past the file's head must be given first
   * (Codex's `session_meta`, which names its folder and branch), if any.
   */
  head?: (file: string) => Promise<Line | null>;
  /** Whether the agent works, as the lines at the end of the file say. */
  working: (tail: Line[]) => boolean;
}

/**
 * A Claude transcript's turns, and the facts its lines name beside them.
 *
 * NOTE: `working` is what `claudeWorking` says of every line so far, kept one
 * line at a time; `cwd`, `gitBranch` and the Lanework card are each the newest
 * a line names, what a walk back from the end finds first.
 */
function claudeRows(folder: string): RowFold {
  const fold = turnFold(folder);
  let working = claudeWorking([]);
  let cwd: string | null = null;
  let branch: string | null = null;
  let card: AgentCard | null = null;
  return {
    ...fold,
    push: (row, where) => {
      fold.push(row, where);
      working = workingAfter(working, row);
      if (typeof row.cwd === "string") cwd = row.cwd;
      if (typeof row.gitBranch === "string" && row.gitBranch)
        branch = row.gitBranch;
      card = laneworkCard(row) ?? card;
    },
    facts: () => ({ working, cwd, branch, card }),
  };
}

const claude: FoldKind = {
  agent: "claude",
  make: claudeRows,
  working: claudeWorking,
};

/**
 * The transcripts folded so far, by file, least recently read first.
 *
 * NOTE: Only the turns are kept, never the parsed lines: a conductor's long
 * conversation is up to {@link CONVERSATION_READ_MAX} of JSON, its turns a
 * fraction of it. The chat (`readConversation`) and the rail
 * (`latestClaudeProposal`) share one fold per file, so a chat that is open
 * and a conductor the rail watches cost one read of each new line. A handful
 * of chats and conductors at a time, hence the cap.
 */
const folded = new Map<string, FoldedTranscript>();
const FOLDED_MAX = 16;
/** One read at a time per file: two folding the same new lines would double them. */
const folding = new Map<string, Promise<unknown>>();

/**
 * A line `claudeWorking` reads as working. Put before another line, it
 * tells a line that decides nothing (the answer stays this one's) from one
 * that decides "not working".
 */
const UNDECIDED: Line = { type: "user", message: { content: "" } };

/**
 * What `claudeWorking` says of the lines so far once `line` is added: it
 * reads back from the end to the first line that decides, so the newest
 * deciding line's verdict stands.
 */
function workingAfter(working: boolean, line: Line): boolean {
  const alone = claudeWorking([line]);
  if (alone) return true;
  return claudeWorking([UNDECIDED, line]) ? working : false;
}

/** `work` once every earlier read of `file` is done. */
function inTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
  const before = folding.get(file) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.catch(() => {});
  folding.set(file, settled);
  void settled.then(() => {
    if (folding.get(file) === settled) folding.delete(file);
  });
  return run;
}

/** A fresh fold of `size` bytes: all of them, or past `max` only the end. */
function startFold(
  kind: FoldKind,
  folder: string,
  size: number,
  mtimeMs: number,
  max: number,
): FoldedTranscript {
  const start = size > max ? size - max : 0;
  return {
    folder,
    max,
    size,
    mtimeMs,
    start,
    end: start,
    aligned: start === 0,
    seen: Buffer.alloc(0),
    fold: kind.make(folder),
    answer: null,
    facts: null,
  };
}

/**
 * The whole lines of `chunk[from, to)`, parsed, each with its place in the
 * file (`base` is where `chunk` starts): `lines`, keeping where each was.
 *
 * NOTE: Split on the bytes, not the text, so a place is a byte offset even
 * past a multi-byte character. A newline byte is never inside one in UTF-8.
 *
 * @param aligned `from` is a line's start; else the first line is cut and
 *   dropped, as `lines` drops a tail's.
 */
function placedLines(
  chunk: Buffer,
  from: number,
  to: number,
  base: number,
  aligned: boolean,
): { line: Line; where: LineSpan }[] {
  const out: { line: Line; where: LineSpan }[] = [];
  let start = from;
  let first = true;
  while (start < to) {
    let end = chunk.indexOf(0x0a, start);
    if (end === -1 || end > to) end = to;
    const skip = first && !aligned;
    first = false;
    if (!skip && end > start) {
      const text = chunk.toString("utf8", start, end);
      if (text.trim())
        try {
          const value: unknown = JSON.parse(text);
          if (value && typeof value === "object")
            out.push({
              line: value as Line,
              where: { at: base + start, length: end - start },
            });
        } catch {
          // Cut, or not ours.
        }
    }
    start = end + 1;
  }
  return out;
}

/** How much of what was folded last is kept, to tell growth from a rewrite. */
const SEEN_TAIL = 4 * 1024;

/**
 * Fold `file`'s whole lines from `entry.end` to `size` into `entry`.
 *
 * NOTE: Not `eachLine`: it hands a line longer than its 1 MB step over cut,
 * and a prompt with a pasted image is that long. Cut, it would not parse,
 * and the chat would lose a turn a whole read of the file keeps.
 *
 * NOTE: The read starts at the last bytes already folded (`seen`), which
 * must still be there: a file written again under the same name, longer
 * than before, would pass for one that grew, and its new lines would be
 * folded onto the old ones.
 *
 * @returns false when the bytes already folded changed: fold it anew.
 */
async function foldNew(
  file: string,
  entry: FoldedTranscript,
  size: number,
): Promise<boolean> {
  if (size <= entry.end) return true;
  const from = entry.end - entry.seen.length;
  const handle = await open(file, "r");
  let chunk: Buffer;
  try {
    const buffer = Buffer.alloc(size - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    chunk = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const kept = entry.seen.length;
  if (chunk.length < kept || !chunk.subarray(0, kept).equals(entry.seen))
    return false;
  // A line still being written waits for the next read, as `lines` drops it.
  const last = chunk.lastIndexOf(0x0a);
  if (last < kept) return true;
  const rows = placedLines(chunk, kept, last + 1, from, entry.aligned);
  entry.end = from + last + 1;
  entry.seen = Buffer.from(
    chunk.subarray(Math.max(0, last + 1 - SEEN_TAIL), last + 1),
  );
  entry.aligned = true;
  entry.answer = null;
  entry.facts = null;
  for (const { line: row, where } of rows) entry.fold.push(row, where);
  return true;
}

/**
 * A fresh fold of `file`, given its head line first when it starts past it
 * ({@link FoldKind.head}).
 */
async function beginFold(
  file: string,
  kind: FoldKind,
  folder: string,
  info: Stats,
  max: number,
): Promise<FoldedTranscript> {
  const entry = startFold(kind, folder, info.size, info.mtimeMs, max);
  if (entry.start > 0) {
    const head = await kind.head?.(file);
    if (head) entry.fold.push(head);
  }
  return entry;
}

/**
 * `file`'s fold, brought up to date with the file. Called inside
 * {@link inTurn} only.
 *
 * NOTE: Kept per file and checked against its size and mtime:
 * - both unchanged: nothing is read;
 * - it grew: only the bytes after the last whole line folded are read and
 *   folded, so only the turns those lines touch change (the last one, a new
 *   one, a call a result answers); every other turn is the same object;
 * - it shrank, changed at the same size, or the last bytes folded are not
 *   what they were: it was rewritten, and is folded again from the start.
 * Past {@link CONVERSATION_READ_MAX} only the end is read. The fold starts
 * there too, and starts again from the new end once it holds a quarter of
 * that more: re-anchored on every growth, a long conversation would be read
 * whole again after every turn. So the chat of such a conversation may show
 * up to a quarter more of its past than the limit, never less.
 *
 * @throws When the conversation has no transcript.
 */
async function refreshFold(
  file: string,
  folder: string,
  max: number,
  kind: FoldKind,
): Promise<{ entry: FoldedTranscript; info: Stats }> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    folded.delete(file);
    throw new Error("That conversation has no transcript.");
  }
  const known = folded.get(file);
  folded.delete(file);
  const kept =
    known !== undefined && known.folder === folder && known.max === max
      ? known
      : null;
  const grew =
    kept !== null &&
    info.size > kept.size &&
    info.size - kept.start <= max + max / 4;
  const same =
    kept !== null && info.size === kept.size && info.mtimeMs === kept.mtimeMs;
  let entry =
    kept !== null && (grew || same)
      ? kept
      : await beginFold(file, kind, folder, info, max);
  // A read that fails leaves no entry: the next read folds it all again.
  if (!(await foldNew(file, entry, info.size))) {
    entry = await beginFold(file, kind, folder, info, max);
    await foldNew(file, entry, info.size);
  }
  entry.size = info.size;
  entry.mtimeMs = info.mtimeMs;
  folded.set(file, entry);
  if (folded.size > FOLDED_MAX)
    folded.delete(folded.keys().next().value as string);
  return { entry, info };
}

/**
 * Whether the agent works on the transcript `entry` folded: a stale file is
 * not working, and after a turn cut off with its process only the lines
 * since decide (`cutOffAt`).
 */
async function foldWorking(
  file: string,
  info: Stats,
  entry: FoldedTranscript,
  kind: FoldKind,
): Promise<boolean> {
  const fresh = Date.now() - info.mtimeMs <= STALE_MS;
  const since =
    cutOffAt(file, info.size) === null ? null : await turnTail(file, info.size);
  return (
    fresh && (since !== null ? kind.working(since) : entry.fold.facts().working)
  );
}

/**
 * The fold's turns as a read shows them: a new list, its last assistant turn
 * open while the agent works.
 *
 * NOTE: The last turn is a copy: the fold's own turn stays as the next line
 * finds it. The other turns are the fold's own, shared: they go out over IPC
 * (copied as they are sent) or are read at once, never kept or changed.
 */
function shownTurns(turns: readonly Turn[], working: boolean): Turn[] {
  const shown = turns.slice();
  const last = shown.at(-1);
  if (last?.role === "assistant")
    shown[shown.length - 1] = shownLast(last, working);
  return shown;
}

/** The last turn's shown copy, by the folded turn and whether it works. */
const shownCopies = new WeakMap<Turn, { working: boolean; copy: Turn }>();

/**
 * `last` with `open` and `endedAt` set for `working`.
 *
 * NOTE: The same copy while neither changes: a thread's read tags each
 * session's turns once and reuses the tag by identity, and a fresh copy here
 * on every read made the newest turn of every earlier session tagged again.
 */
function shownLast(last: AssistantTurn, working: boolean): Turn {
  const known = shownCopies.get(last);
  if (known && known.working === working) return known.copy;
  const copy: Turn = {
    ...last,
    open: working,
    endedAt: working ? null : last.endedAt,
  };
  shownCopies.set(last, { working, copy });
  return copy;
}

/**
 * Read conversation `id` of `folder` for the chat.
 *
 * NOTE: The path is built from the folder and an id that passed
 * {@link isAgentSessionId}, inside Claude's own folder under `home`.
 *
 * Folded once and kept ({@link refreshFold}): a read after the transcript
 * grew parses only the lines written since, not the whole file again, so a
 * long turn read after every line costs what it wrote, not its square.
 * Past {@link CONVERSATION_READ_MAX} bytes only the end is read, and
 * `truncated` says so.
 *
 * @throws When the conversation has no transcript.
 */
// NOTE: Async so a bad id rejects like a missing file, never throws at the
// caller before it has a promise to catch.
export async function readConversation(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<Conversation> {
  return readFolded(transcriptPath(home, folder, id), folder, id, max, claude);
}

/**
 * Conversation `id`, read from `file` as `kind` folds it: what
 * {@link readConversation} and Codex's read both are.
 *
 * @throws When the file is gone.
 */
export function readFolded(
  file: string,
  folder: string,
  id: string,
  max: number,
  kind: FoldKind,
): Promise<Conversation> {
  return inTurn(file, async () => {
    const { entry, info } = await refreshFold(file, folder, max, kind);
    const working = await foldWorking(file, info, entry, kind);
    const facts = entry.fold.facts();
    return {
      id,
      agent: kind.agent,
      cwd: facts.cwd,
      branch: facts.branch,
      turns: shownTurns(entry.fold.peek(), working),
      working,
      card: working ? facts.card : null,
      settings: null,
      truncated: entry.start > 0,
    };
  });
}

// ─── A long tool result, read back whole ─────────────────────────────────────

/**
 * The longest line {@link readToolOutput} reads back. A tool result's line
 * repeats it (`toolUseResult`), and a Read of a large file is long.
 */
const RESULT_LINE_MAX = 64 * 1024 * 1024;

/**
 * The whole result of tool call `call` in conversation `id`, which a read
 * sent cut ({@link ToolCall.outputCut}).
 *
 * NOTE: The fold keeps only where each such result's line is in the file,
 * never its text: the chat asks for one when the person opens it, and that
 * one line is read from disk then. The fold is brought up to date first
 * ({@link refreshFold}), so a result written since the last read is found,
 * and a transcript rewritten since is folded again, its places with it.
 *
 * @throws When the conversation has no transcript, or the call no cut
 *   result in it.
 */
export async function readToolOutput(
  home: string,
  folder: string,
  id: string,
  call: string,
  max = CONVERSATION_READ_MAX,
): Promise<ToolOutput> {
  const file = transcriptPath(home, folder, id);
  return inTurn(file, async () => {
    const { entry } = await refreshFold(file, folder, max, claude);
    const where = entry.fold.longResult(call);
    if (!where || where.length > RESULT_LINE_MAX)
      throw new Error("That tool result is not in the transcript.");
    const handle = await open(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(where.length);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        where.length,
        where.at,
      );
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      throw new Error("That tool result is not in the transcript.");
    }
    const content = (line.message as { content?: unknown } | undefined)
      ?.content;
    const part = Array.isArray(content)
      ? (content as Record<string, unknown>[]).find(
          (entry) =>
            entry?.type === "tool_result" && entry.tool_use_id === call,
        )
      : undefined;
    if (!part) throw new Error("That tool result is not in the transcript.");
    const whole = resultText(part.content);
    return whole.length > TOOL_OUTPUT_FULL_MAX
      ? { text: whole.slice(0, TOOL_OUTPUT_FULL_MAX), cut: true }
      : { text: whole, cut: false };
  });
}

// ─── The rail's latest proposal, from the same fold ─────────────────────────

/**
 * The id of conversation `id`'s latest proposal when it waits on the user,
 * or null: what `deriveProposals` answers of the chat's turns
 * (`readConversation`), without reading the whole transcript each time.
 *
 * NOTE: The chat's fold ({@link refreshFold}); the answer is kept too while
 * no line is folded, unless whether it works or `leads` changed.
 *
 * @throws When the conversation has no transcript.
 */
// NOTE: Async for the same reason as `readConversation`.
export async function latestClaudeProposal(
  home: string,
  folder: string,
  id: string,
  leads: readonly TeamLead[],
  max = CONVERSATION_READ_MAX,
): Promise<string | null> {
  return latestFoldedProposal(
    transcriptPath(home, folder, id),
    folder,
    leads,
    max,
    claude,
  );
}

/**
 * {@link latestClaudeProposal} of `file`, as `kind` folds it: Codex's too.
 *
 * @throws When the file is gone.
 */
export function latestFoldedProposal(
  file: string,
  folder: string,
  leads: readonly TeamLead[],
  max: number,
  kind: FoldKind,
): Promise<string | null> {
  return inTurn(file, async () => {
    const { entry, info } = await refreshFold(file, folder, max, kind);
    const working = await foldWorking(file, info, entry, kind);
    const key = JSON.stringify(leads);
    if (entry.answer?.working === working && entry.answer.leads === key)
      return entry.answer.id;
    const answer = latestReadyProposal(
      shownTurns(entry.fold.peek(), working),
      leads,
    );
    entry.answer = { working, leads: key, id: answer };
    return answer;
  });
}

// ─── The panel's small facts, from the same fold ────────────────────────────

/**
 * What a panel reads of a whole conversation (its web pages), from `file`'s
 * fold, as `kind` folds it.
 *
 * NOTE: The same fold the chat and the rail read ({@link refreshFold}), and
 * the answer is kept on it until a line is folded: a panel that asks again
 * with nothing written reads nothing and scans no turn, and one that asks
 * after a turn scans the turns the fold holds, never the file. The turns
 * are not sent.
 *
 * @throws When the file is gone.
 */
export function foldedFacts(
  file: string,
  folder: string,
  max: number,
  kind: FoldKind,
): Promise<ConversationFacts> {
  return inTurn(file, async () => {
    const { entry } = await refreshFold(file, folder, max, kind);
    entry.facts ??= { web: webSourcesOf(entry.fold.peek()) };
    return entry.facts;
  });
}

/** {@link foldedFacts} of Claude conversation `id`. */
export function claudeFacts(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<ConversationFacts> {
  return foldedFacts(transcriptPath(home, folder, id), folder, max, claude);
}

/** Re-exported for the engine's live turns. */
export type { Line };

/**
 * The words inside a `<local-command-stdout>` (or `-stderr`) block of a
 * `system` `local_command` line, or null when it carries none.
 */
function localCommandText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const match =
    /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(
      content,
    );
  const text = match?.[1]?.trim();
  return text ? text : null;
}
