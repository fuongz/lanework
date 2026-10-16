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

/** A Claude model the picker offers, newest first within a family. */
export interface ClaudeModel {
  /** What `--model` is given — an alias or a full id. */
  id: string;
  label: string;
  /** Shown below the current generation, after a divider. */
  legacy?: boolean;
}

/**
 * The picker's list, fixed in code (FE-62/D9).
 *
 * ⚠️ `id` is checked against this list in main: it becomes an argument, and
 * nothing the page typed may.
 */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", legacy: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", legacy: true },
  { id: "claude-opus-5", label: "Opus 5", legacy: true },
  { id: "claude-fable-5", label: "Fable 5", legacy: true },
  { id: "claude-opus-4-8", label: "Opus 4.8", legacy: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", legacy: true },
  { id: "claude-opus-4-6", label: "Opus 4.6", legacy: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", legacy: true },
];

export const DEFAULT_MODEL = "claude-opus-5-5";

export function isClaudeModel(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_MODELS.some((m) => m.id === value);
}

/** The model's label, or the id as the CLI named it when it is not listed. */
export function modelName(id: string | null): string | null {
  if (!id) return null;
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id;
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
    !isClaudeModel(v.model) ||
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
  text: string;
  attachments: OutgoingAttachment[];
  settings: ComposerSettings;
}

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
}

export type PermissionAnswer =
  | {
      behavior: "allow" /** Also switch the session to this mode. */;
      mode?: Permission;
    }
  | { behavior: "deny"; message?: string };

/**
 * Where a conversation's engine stands. Only one process writes a
 * conversation at a time: `terminal` means a pty is running Claude on it, and
 * the composer stays paused until that tab is stopped.
 */
export type EngineState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running"; queued: number }
  | { state: "terminal"; terminalId: string }
  | { state: "error"; message: string };

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
  send: "conversation:send",
  /** Interrupt the running turn (the Stop button). */
  stop: "conversation:stop",
  /** Drop what is queued behind the running turn. */
  clearQueue: "conversation:clear-queue",
  answerPermission: "conversation:answer-permission",
  /** Fork into a new conversation (`--fork-session`), answer its id (D7). */
  fork: "conversation:fork",
  /** Let the composer take over: stop the pty running this conversation. */
  takeOver: "conversation:take-over",
  /** Stop the engine process so a terminal can resume the conversation (D3). */
  release: "conversation:release",
  engineState: "conversation:engine-state",
  /** The last settings used anywhere, for a conversation never sent from chat. */
  lastSettings: "conversation:last-settings",
  linkPreview: "conversation:link-preview",
  /** Slash commands, or files in the workspace's folder, matching a query. */
  suggest: "conversation:suggest",
  /** Open a link the person clicked in the chat in the OS browser. */
  openLink: "conversation:open-link",
  /** Main → renderer: a `ConversationEvent`. */
  event: "conversation:event",
} as const;

export interface DesktopConversationApi {
  read: (workspace: string, conversation: string) => Promise<Conversation>;
  /** Resolves once queued or started — not when the turn ends. */
  send: (request: SendRequest) => Promise<EngineState>;
  stop: (workspace: string, conversation: string) => Promise<void>;
  clearQueue: (workspace: string, conversation: string) => Promise<void>;
  answerPermission: (
    workspace: string,
    conversation: string,
    id: string,
    answer: PermissionAnswer,
  ) => Promise<void>;
  fork: (workspace: string, conversation: string) => Promise<string>;
  takeOver: (workspace: string, conversation: string) => Promise<EngineState>;
  release: (workspace: string, conversation: string) => Promise<void>;
  engineState: (
    workspace: string,
    conversation: string,
  ) => Promise<EngineState>;
  lastSettings: () => Promise<ComposerSettings>;
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
  /** A path for a dropped or pasted `File`, as Electron knows it. */
  pathForFile: (file: File) => string;
  onEvent: (listener: (event: ConversationEvent) => void) => () => void;
}
