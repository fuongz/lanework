// The conversation view's contract (FE-62): a Claude conversation read as a
// chat — turns, folded tool calls, per-turn usage — and a composer that sends
// the next turn through the user's own `claude` CLI, headless.
//
// ⚠️ As with the terminal (FE-19), the renderer never names a command, a
// binary or a folder. It names a WORKSPACE and a conversation id; main
// resolves the folder from the links it wrote down itself and runs the one
// CLI it stands for. Settings are names picked from the lists below, checked
// again in main before they become a flag.

import type { AgentCard } from "./terminal";

// ─── Composer settings (FE-62/D9) ───────────────────────────────────────────

/** The CLI a conversation runs on: Claude Code, or Codex. */
export type ConversationAgent = "claude" | "codex";

export const AGENT_LABELS: Record<ConversationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** A model the picker offers, newest first within a family. */
export interface AgentModel {
  /** What `--model` / `-m` is given — an alias or a full id. */
  id: string;
  label: string;
  /** The CLI that runs it: picking it picks the agent (new conversation). */
  agent: ConversationAgent;
  /** Shown below the current generation, after a divider. */
  legacy?: boolean;
}

/** @deprecated The old name, from when every model was Claude's. */
export type ClaudeModel = AgentModel;

/**
 * The picker's list, fixed in code (FE-62/D9).
 *
 * ⚠️ `id` is checked against this list in main: it becomes an argument, and
 * nothing the page typed may.
 */
export const CLAUDE_MODELS: readonly AgentModel[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude" },
  { id: "claude-fable-5-1", label: "Fable 5.1", agent: "claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", agent: "claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", agent: "claude" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", agent: "claude", legacy: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", agent: "claude", legacy: true },
  { id: "claude-opus-5", label: "Opus 5", agent: "claude", legacy: true },
  { id: "claude-fable-5", label: "Fable 5", agent: "claude", legacy: true },
  { id: "claude-opus-4-8", label: "Opus 4.8", agent: "claude", legacy: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", agent: "claude", legacy: true },
  { id: "claude-opus-4-6", label: "Opus 4.6", agent: "claude", legacy: true },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    agent: "claude",
    legacy: true,
  },
];

/**
 * Codex's (ChatGPT's) models when its own list cannot be read — no
 * `~/.codex/models_cache.json` yet. Main reads that file (`codexModels`)
 * and hands the list over with `setCodexModels`.
 */
export const CODEX_MODELS: readonly AgentModel[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", agent: "codex" },
  { id: "gpt-6-astra", label: "GPT-6-Astra", agent: "codex" },
  { id: "gpt-6-sol", label: "GPT-6-Sol", agent: "codex" },
  { id: "gpt-6-luna", label: "GPT-6-Luna", agent: "codex" },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", agent: "codex", legacy: true },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", agent: "codex", legacy: true },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", agent: "codex", legacy: true },
];

/** What a Codex model id may be: it becomes `-m`'s value. */
export const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Codex's models as this process knows them: the fallback until main has
 * read Codex's own cache (in main) or the page has asked main (renderer).
 */
let codexList: readonly AgentModel[] = CODEX_MODELS;
let everyModel: readonly AgentModel[] = [...CLAUDE_MODELS, ...codexList];
const listeners = new Set<() => void>();

/**
 * Take `list` as Codex's models — the ones `codex` itself lists. An empty
 * list keeps the fallback; ids that are not plain names are dropped.
 */
export function setCodexModels(list: readonly AgentModel[]): void {
  const clean = list.filter(
    (entry) =>
      entry.agent === "codex" &&
      CODEX_MODEL_ID.test(entry.id) &&
      !entry.id.startsWith("claude-"),
  );
  const next = clean.length > 0 ? clean : CODEX_MODELS;
  if (JSON.stringify(next) === JSON.stringify(codexList)) return;
  codexList = next;
  everyModel = [...CLAUDE_MODELS, ...codexList];
  for (const listener of listeners) listener();
}

/** Told when `setCodexModels` changed the list (the picker re-draws). */
export function onModelsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Every model the picker offers: Claude's, then Codex's current list. The
 * same array until the list changes — a snapshot React may compare.
 */
export function allModels(): readonly AgentModel[] {
  return everyModel;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Each CLI's default: Codex's is the first of its list. */
export function defaultModel(agent: ConversationAgent): string {
  return agent === "codex"
    ? (codexList[0]?.id ?? "gpt-6.1-sol")
    : DEFAULT_MODEL;
}

export function isModel(value: unknown): value is string {
  return typeof value === "string" && allModels().some((m) => m.id === value);
}

/** @deprecated Every listed model, Codex's too: use `isModel`. */
export const isClaudeModel = isModel;

/** The CLI that runs model `id`; Claude for one not listed. */
export function agentOfModel(id: string | null): ConversationAgent {
  return allModels().find((m) => m.id === id)?.agent ?? "claude";
}

/** The model's label, or the id as the CLI named it when it is not listed. */
export function modelName(id: string | null): string | null {
  if (!id) return null;
  return allModels().find((m) => m.id === id)?.label ?? id;
}

/**
 * `settings` for a conversation on `agent`: a model of another CLI — the
 * last settings used anywhere were Claude's, this one is Codex — becomes
 * that agent's default.
 */
export function settingsFor(
  agent: ConversationAgent,
  settings: ComposerSettings,
): ComposerSettings {
  return agentOfModel(settings.model) === agent
    ? settings
    : { ...settings, model: defaultModel(agent) };
}

/** `--effort`, in the CLI's own order. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isEffort(value: unknown): value is Effort {
  return (
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * `--permission-mode`, as the picker offers it (ảnh 9). The CLI's `plan` and
 * `dontAsk` are not offered.
 */
export const PERMISSIONS = [
  "manual",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_COPY: Record<
  Permission,
  { label: string; description: string }
> = {
  manual: {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  acceptEdits: {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  auto: {
    label: "Auto",
    description: "An AI reviewer can approve or deny actions.",
  },
  bypassPermissions: {
    label: "Full access",
    description:
      "Allow commands, edits, and supported MCP confirmations without prompts.",
  },
};

export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    (PERMISSIONS as readonly string[]).includes(value)
  );
}

export interface ComposerSettings {
  model: string;
  effort: Effort;
  /** Fast mode: the same model, faster output. */
  fast: boolean;
  permission: Permission;
}

export const DEFAULT_SETTINGS: ComposerSettings = {
  model: DEFAULT_MODEL,
  effort: "medium",
  fast: false,
  permission: "manual",
};

/** A settings object from the page, checked field by field; null if any is off. */
export function checkSettings(value: unknown): ComposerSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !isModel(v.model) ||
    !isEffort(v.effort) ||
    typeof v.fast !== "boolean" ||
    !isPermission(v.permission)
  )
    return null;
  return {
    model: v.model,
    effort: v.effort,
    fast: v.fast,
    permission: v.permission,
  };
}

// ─── The transcript, as turns ───────────────────────────────────────────────

/** How a tool call is drawn and counted in its group's title (FE-62/D6). */
export type ToolKind =
  | "edit" // Edit, Write, MultiEdit, NotebookEdit
  | "command" // Bash, and a background shell
  | "read" // Read
  | "search" // Grep, Glob, LS, WebSearch
  | "fetch" // WebFetch
  | "agent" // Task / Agent: a sub-agent
  | "mcp" // mcp__server__tool
  | "other";

export interface ToolCall {
  /** The CLI's `tool_use` id. */
  id: string;
  /** As the CLI names it: `Bash`, `Edit`, `mcp__lanework__get_review`. */
  tool: string;
  kind: ToolKind;
  /** One line for the folded row: a command's first line, a path, a pattern. */
  summary: string;
  /** Its input as pretty JSON, cut at `TOOL_TEXT_MAX`. */
  input: string;
  /** Its result as text, cut at `TOOL_TEXT_MAX`; null while it runs. */
  output: string | null;
  /** Its result said it failed. */
  error: boolean;
  /** The file it read or wrote, when it names one — for the file chip. */
  filePath: string | null;
  /** A sub-agent's id, when this call spawned one (opens the sub-agent view). */
  subagent: string | null;
}

/** The most of one tool call's input or output the page is sent, in characters. */
export const TOOL_TEXT_MAX = 16 * 1024;

/** Something the user attached to a prompt — a pasted image, a file. */
export interface Attachment {
  name: string;
  /** `image/png`, `text/plain`… */
  mediaType: string;
  /** A local path main can read back, when the CLI kept one; else null. */
  path: string | null;
}

/**
 * An image named in the chat, read back (FE-65): its real path and its
 * bytes as a `data:` URL — or, when it is not there or out of scope, the
 * path as asked.
 */
export type ImagePreview =
  | { found: true; path: string; url: string }
  | { found: false; path: string };

/** Spans of one assistant turn, in the order they were written. */
export type Block =
  | { type: "text"; text: string }
  /** Consecutive tool calls between two pieces of text, folded as one (D6). */
  | { type: "tools"; calls: ToolCall[] }
  /** The agent asked to use a tool and is waiting for an answer (D1). */
  | { type: "permission"; request: PermissionRequest };

/** One turn's numbers, for the Usage tooltip (FE-62/D7). */
export interface TurnUsage {
  /** Uncached input tokens: `input_tokens + cache_creation_input_tokens`. */
  input: number;
  output: number;
  /** `cache_read_input_tokens`. */
  cached: number;
  /** `cached / (cached + input)`, 0–100; null when nothing was read. */
  cacheHitPct: number | null;
  /** Output tokens over the turn's wall time; null when it cannot be told. */
  tokPerSec: number | null;
}

export interface UserTurn {
  role: "user";
  /** The transcript line's uuid — stable, the TOC's anchor (D5). */
  id: string;
  text: string;
  attachments: Attachment[];
  /** ISO. */
  at: string;
}

export interface AssistantTurn {
  role: "assistant";
  /** The first transcript line of the turn. */
  id: string;
  blocks: Block[];
  /** The model that answered, as the CLI names it. */
  model: string | null;
  usage: TurnUsage | null;
  /** When it started and last wrote, ISO. */
  at: string;
  endedAt: string | null;
  /** Still being written: the last turn of a working conversation. */
  open: boolean;
}

export type Turn = UserTurn | AssistantTurn;

export interface Conversation {
  id: string;
  /** The CLI whose transcript it is, and that sends its next turn. */
  agent: ConversationAgent;
  /** The folder it runs in, for the composer's "Current checkout" (display only). */
  cwd: string | null;
  /** Its git branch when it was last written, for the composer row. */
  branch: string | null;
  turns: Turn[];
  /** A turn is open — the agent is thinking or working. */
  working: boolean;
  /** The card its agent last named to the Lanework MCP, as the rail has it. */
  card: AgentCard | null;
  /** The settings it last ran with here, or null when never sent from chat. */
  settings: ComposerSettings | null;
  /** Longer than one read takes: its start was dropped, the end kept. */
  truncated: boolean;
}

/** The most of a transcript one read takes. */
export const CONVERSATION_READ_MAX = 32 * 1024 * 1024;

// ─── Sending (FE-62/D1) ─────────────────────────────────────────────────────

/** A file the composer attaches, by the path the OS dialog or a drop gave. */
export type OutgoingAttachment =
  /** A file on disk, by the path `pathForFile` gave for a pick or a drop. */
  | { kind: "path"; path: string }
  /**
   * A pasted image, which has no path: its bytes, base64. Main sends it as an
   * image block; at most `PASTE_MAX` bytes decoded.
   */
  | { kind: "data"; name: string; mediaType: string; data: string };

/** The most a pasted image may weigh, decoded. */
export const PASTE_MAX = 5 * 1024 * 1024;

/** What `/` and `@` offer in the composer (FE-62/D8). */
export type SuggestionKind = "command" | "file";

export interface Suggestion {
  /** What is inserted: `/review`, `@src/app.tsx`. */
  value: string;
  /** One line under it: a command's description, a file's folder. */
  detail: string | null;
}

export interface SendRequest {
  workspace: string;
  conversation: string;
  /**
   * The page's name for this message, so it is the same one while it waits
   * in the queue (FE-67). Main makes one when absent.
   */
  id?: string;
  text: string;
  attachments: OutgoingAttachment[];
  settings: ComposerSettings;
}

/** A new conversation's first message: main names the conversation. */
export type StartRequest = Omit<SendRequest, "conversation">;

/**
 * The CLI asked to use a tool (`control_request` / `can_use_tool`) and waits.
 * Shown as a card in the chat; answered with `answerPermission`.
 */
export interface PermissionRequest {
  /** The control request's id. */
  id: string;
  tool: string;
  /** What it would do, in one line: the CLI's `description`, else a summary. */
  summary: string;
  /** Its input as pretty JSON, cut at `TOOL_TEXT_MAX`. */
  input: string;
  /** The CLI offers "allow and switch to this mode for the session". */
  suggestMode: Permission | null;
  /**
   * `AskUserQuestion`: the questions Claude asks before acting, drawn as a
   * question card instead of Allow/Deny. Null for every other tool.
   */
  questions: AskQuestion[] | null;
}

/** One of `AskUserQuestion`'s questions, as the CLI's input has it. */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** Most answers one reply carries, and the longest one. */
export const ANSWERS_MAX = 8;
export const ANSWER_MAX = 2000;

export type PermissionAnswer =
  | {
      behavior: "allow" /** Also switch the session to this mode. */;
      mode?: Permission;
      /**
       * `AskUserQuestion`'s answers, by question text: an option's label —
       * several joined by ", " — or what was typed under "Something else".
       */
      answers?: Record<string, string>;
    }
  | { behavior: "deny"; message?: string };

/**
 * A message the engine holds back (FE-67): sent while the CLI could not take
 * it in — the queue is paused, the turn is not ready, or it asks for other
 * settings than the running turn's. It goes once it can.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: { name: string; image: boolean }[];
  /** Why it did not go — it stays until sent, edited or removed. */
  error: string | null;
}

/** What the engine holds back, when it holds anything. */
export interface EngineQueue {
  queue?: QueuedMessage[];
  /** Stopped with messages waiting: they go on Resume, or the next send. */
  paused?: boolean;
}

/**
 * Where a conversation's engine stands. Only one process writes a
 * conversation at a time: `terminal` means a pty is running Claude on it, and
 * the composer stays paused until that tab is stopped.
 */
export type EngineState =
  | ({ state: "idle" } & EngineQueue)
  | ({ state: "starting" } & EngineQueue)
  | ({ state: "running" } & EngineQueue)
  | { state: "terminal"; terminalId: string }
  | ({ state: "error"; message: string } & EngineQueue);

/** Main → renderer, as a turn streams in. */
export type ConversationEvent =
  | {
      type: "state";
      workspace: string;
      conversation: string;
      engine: EngineState;
    }
  /** The transcript moved on: read it again (or patch from `turn`). */
  | { type: "turn"; workspace: string; conversation: string; turn: Turn }
  /**
   * The engine saw the transcript move on — a Codex item finished — and the
   * page reads it again, without waiting for the file watcher.
   */
  | { type: "moved"; workspace: string; conversation: string }
  /** Text arriving for the open turn's last text block, before the line lands. */
  | { type: "delta"; workspace: string; conversation: string; text: string }
  | {
      type: "permission";
      workspace: string;
      conversation: string;
      request: PermissionRequest;
    }
  /** A pending permission was answered (here or because the turn ended). */
  | {
      type: "permission-done";
      workspace: string;
      conversation: string;
      id: string;
    };

// ─── Links (FE-62/D4) ───────────────────────────────────────────────────────

/** A link's favicon and title, fetched by main and kept on disk per domain. */
export interface LinkPreview {
  url: string;
  /** The page's `<title>`, trimmed; null when it had none or fetching failed. */
  title: string | null;
  /** A `data:` URL of the icon; null when none was found. */
  icon: string | null;
}

/** A link main may open in the browser: a preview URL with no credentials. */
export function isOpenableUrl(value: unknown): value is string {
  if (!isPreviewUrl(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
}

/** Only these reach main's fetcher; anything else is refused. */
export function isPreviewUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ─── IPC ────────────────────────────────────────────────────────────────────

export const conversationChannels = {
  read: "conversation:read",
  /** Start a NEW conversation with its first message; answers its id. */
  start: "conversation:start",
  send: "conversation:send",
  /** Interrupt the running turn (the Stop button). */
  stop: "conversation:stop",
  /** Drop what is queued behind the running turn; answers how many went. */
  clearQueue: "conversation:clear-queue",
  /** Take one queued message back out, to be edited (FE-67). */
  takeQueued: "conversation:take-queued",
  /** Drop one queued message. */
  removeQueued: "conversation:remove-queued",
  /** Let a paused queue go on. */
  resumeQueue: "conversation:resume-queue",
  answerPermission: "conversation:answer-permission",
  /** Fork into a new conversation (`--fork-session`), answer its id (D7). */
  fork: "conversation:fork",
  /** Let the composer take over: stop the pty running this conversation. */
  takeOver: "conversation:take-over",
  /** Stop the engine process so a terminal can resume the conversation (D3). */
  release: "conversation:release",
  /** The rail's Stop: end the engine, cutting off a running turn. */
  close: "conversation:close",
  /** A workspace's conversations whose engine process is alive (Running). */
  alive: "conversation:alive",
  engineState: "conversation:engine-state",
  /** What the engine is waiting on the person for: a tool, or questions. */
  permissions: "conversation:permissions",
  /** The last settings used anywhere, for a conversation never sent from chat. */
  lastSettings: "conversation:last-settings",
  /** Codex's models, as `codex` lists them in its own cache. */
  codexModels: "conversation:codex-models",
  linkPreview: "conversation:link-preview",
  /** Slash commands, or files in the workspace's folder, matching a query. */
  suggest: "conversation:suggest",
  /** Open a link the person clicked in the chat in the OS browser. */
  openLink: "conversation:open-link",
  /** An image the chat names, read back for its lightbox (FE-65). */
  image: "conversation:image",
  /** That image, opened in the OS's default app. */
  openImage: "conversation:open-image",
  /** Main → renderer: a `ConversationEvent`. */
  event: "conversation:event",
} as const;

export interface DesktopConversationApi {
  read: (workspace: string, conversation: string) => Promise<Conversation>;
  /**
   * A new conversation, `request` its first message: main makes the id and
   * answers it once the turn has started — not when it ends.
   */
  start: (
    request: StartRequest,
  ) => Promise<{ conversation: string; engine: EngineState }>;
  /** Resolves once queued or started — not when the turn ends. */
  send: (request: SendRequest) => Promise<EngineState>;
  stop: (workspace: string, conversation: string) => Promise<void>;
  /** Answers how many were dropped: one may have started meanwhile. */
  clearQueue: (workspace: string, conversation: string) => Promise<number>;
  /** Null when it is no longer queued: it went meanwhile. */
  takeQueued: (
    workspace: string,
    conversation: string,
    id: string,
  ) => Promise<{ text: string; attachments: OutgoingAttachment[] } | null>;
  removeQueued: (
    workspace: string,
    conversation: string,
    id: string,
  ) => Promise<boolean>;
  resumeQueue: (workspace: string, conversation: string) => Promise<void>;
  answerPermission: (
    workspace: string,
    conversation: string,
    id: string,
    answer: PermissionAnswer,
  ) => Promise<void>;
  fork: (workspace: string, conversation: string) => Promise<string>;
  takeOver: (workspace: string, conversation: string) => Promise<EngineState>;
  release: (workspace: string, conversation: string) => Promise<void>;
  close: (workspace: string, conversation: string) => Promise<void>;
  alive: (workspace: string) => Promise<string[]>;
  engineState: (
    workspace: string,
    conversation: string,
  ) => Promise<EngineState>;
  /**
   * The requests the engine is still waiting on, for a page that opens after
   * they were asked: `permission` events reach only the pages already open.
   */
  permissions: (
    workspace: string,
    conversation: string,
  ) => Promise<PermissionRequest[]>;
  lastSettings: () => Promise<ComposerSettings>;
  /** Codex's models, read from `~/.codex/models_cache.json` by main. */
  codexModels: () => Promise<AgentModel[]>;
  suggest: (
    workspace: string,
    kind: SuggestionKind,
    query: string,
  ) => Promise<Suggestion[]>;
  linkPreview: (url: string) => Promise<LinkPreview>;
  /**
   * Open a clicked link in the OS browser: http(s) only, no credentials.
   *
   * ⚠️ Its own channel, not `window.open`: the window's popup handler stays
   * GitHub-only (external-links.spec.ts), and only a click in the chat
   * reaches this.
   */
  openLink: (url: string) => Promise<void>;
  /**
   * The image a chat badge names (FE-65) — `details.png`, `assets/x.png`, an
   * attached `/tmp/…/1.png` — as a `data:` URL. Main reads only the
   * workspace's folder and the conversation's own attachments.
   */
  image: (
    workspace: string,
    conversation: string,
    path: string,
  ) => Promise<ImagePreview>;
  /** That image in the OS's default app; the same scope as `image`. */
  openImage: (
    workspace: string,
    conversation: string,
    path: string,
  ) => Promise<void>;
  /** A path for a dropped or pasted `File`, as Electron knows it. */
  pathForFile: (file: File) => string;
  onEvent: (listener: (event: ConversationEvent) => void) => () => void;
}
