// The conversation view's contract: a Claude conversation read as a chat
// (turns, folded tool calls, per-turn usage), and a composer that sends the
// next turn through the user's own `claude` CLI, headless.
//
// NOTE: As with the terminal (FE-19), the renderer never names a command, a
// binary or a folder. It names a project and a conversation id. Main
// resolves the folder from the links it wrote itself and runs the one CLI it
// stands for. Settings are names picked from the lists below, checked again
// in main before they become a flag.

import type { TeamLead } from "./orchestration";
import type { AgentCard, SessionLauncher } from "./terminal";

// ─── Composer settings ──────────────────────────────────────────────────────

/** The CLI a conversation runs on: Claude Code, Codex, or OpenCode (FE-104). */
export type ConversationAgent = "claude" | "codex" | "opencode";

export const AGENT_LABELS: Record<ConversationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** A model the picker offers, newest first within a family. */
export interface AgentModel {
  /** What `--model` / `-m` is given: an alias or a full id. */
  id: string;
  label: string;
  /** The CLI that runs it. Picking it picks the agent (a new conversation). */
  agent: ConversationAgent;
  /** Shown below the current generation, after a divider. */
  legacy?: boolean;
  /**
   * The heading the picker lists it under: OpenCode's provider, as its
   * service names it ("OpenCode Go"). None for Claude's and Codex's.
   */
  group?: string;
  /** The one its CLI starts on by itself, marked "Default" in the picker. */
  preferred?: boolean;
  /**
   * The efforts it takes, in the CLI's order; none when it takes none.
   * Unset: every one of {@link EFFORTS}, as for a model the CLI never
   * described (FE-135/D5).
   */
  efforts?: readonly Effort[];
  /** False when it has no fast mode; unset when its CLI does not say. */
  fast?: boolean;
  /**
   * Added by the user in Settings → Harness (FE-146), not listed by its
   * CLI: the CLI is given the id as typed.
   */
  custom?: boolean;
}

/**
 * Claude's models when its CLI has not listed them yet, or could not
 * (FE-62/D9). Main asks `claude` itself and hands its list over with
 * {@link setClaudeModels} (FE-135).
 *
 * NOTE: `id` is checked against the current list in main. It becomes an
 * argument, and nothing the page typed may.
 */
export const CLAUDE_MODELS: readonly AgentModel[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude" },
  { id: "claude-fable-5-2", label: "Fable 5.2", agent: "claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", agent: "claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", agent: "claude" },
  { id: "claude-fable-5-1", label: "Fable 5.1", agent: "claude", legacy: true },
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
 * Codex's (ChatGPT's) models when its own list cannot be read.
 *
 * That is before `~/.codex/models_cache.json` exists. Main reads that file
 * and hands the list over with {@link setCodexModels}.
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

/**
 * OpenCode's models, fixed in code: none (FE-104).
 *
 * NOTE: OpenCode's models are the providers the user configured, as
 * `provider/model` ids its service lists at runtime. No static list could be
 * right, so the picker offers OpenCode's only once main has read them.
 */
export const OPENCODE_MODELS: readonly AgentModel[] = [];

/**
 * What a Claude model id may be: it becomes `--model`'s value. Never a
 * slash: that is an OpenCode id (FE-105), and never a leading dash.
 */
export const CLAUDE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,127}$/;

/** What a Codex model id may be: it becomes `-m`'s value. */
export const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * What an OpenCode model id may be: `provider/model`, as its service names
 * them. The model part may hold slashes of its own (a gateway's
 * `openai/gpt-…`); the provider is everything before the first. A variant
 * (reasoning effort) is not part of it.
 */
export const OPENCODE_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Claude's models as this process knows them; see {@link CLAUDE_MODELS}. */
let claudeList: readonly AgentModel[] = CLAUDE_MODELS;
/**
 * Codex's models as this process knows them.
 *
 * The fallback until main has read Codex's own cache (in main), or the page
 * has asked main (in the renderer).
 */
let codexList: readonly AgentModel[] = CODEX_MODELS;
/** OpenCode's models as main last read them from its service. */
let opencodeList: readonly AgentModel[] = OPENCODE_MODELS;
/** The user's own models (FE-146), after their CLI's. */
let customList: readonly AgentModel[] = [];
let everyModel: readonly AgentModel[] = [
  ...claudeList,
  ...codexList,
  ...opencodeList,
];
const listeners = new Set<() => void>();

/** One list again from the four, and every picker told. */
function relist(): void {
  const listed = [...claudeList, ...codexList, ...opencodeList];
  const ids = new Set(listed.map((entry) => entry.id));
  // A custom id its CLI has since listed is the CLI's, once.
  everyModel = [...listed, ...customList.filter((entry) => !ids.has(entry.id))];
  for (const listener of listeners) listener();
}

/** Whether `id` can be given to `agent`'s CLI as its model. */
export function isModelIdFor(agent: ConversationAgent, id: string): boolean {
  if (agent === "claude") return CLAUDE_MODEL_ID.test(id);
  if (agent === "codex")
    return CODEX_MODEL_ID.test(id) && !id.startsWith("claude-");
  return OPENCODE_MODEL_ID.test(id);
}

/** A model the user added (FE-146), as kept and as sent to main. */
export interface CustomModel {
  agent: ConversationAgent;
  id: string;
  /** What the picker calls it; the id when left empty. */
  label: string;
}

/** At most this many custom models are kept. */
export const CUSTOM_MODELS_MAX = 100;

/**
 * Take `list` as the user's own models (FE-146): each given to its CLI as
 * typed. Ids its CLI would refuse are dropped, and so is anything past
 * {@link CUSTOM_MODELS_MAX}.
 */
export function setCustomModels(list: readonly CustomModel[]): void {
  const next: AgentModel[] = [];
  for (const entry of list.slice(0, CUSTOM_MODELS_MAX)) {
    if (
      !entry ||
      (entry.agent !== "claude" &&
        entry.agent !== "codex" &&
        entry.agent !== "opencode") ||
      typeof entry.id !== "string" ||
      !isModelIdFor(entry.agent, entry.id) ||
      next.some((kept) => kept.id === entry.id)
    )
      continue;
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 80)
        : entry.id;
    next.push({
      id: entry.id,
      label,
      agent: entry.agent,
      custom: true,
      ...(entry.agent === "opencode" ? { group: "Custom" } : {}),
    });
  }
  if (JSON.stringify(next) === JSON.stringify(customList)) return;
  customList = next;
  relist();
}

/**
 * Take `list` as Claude's models, the ones `claude` itself lists (FE-135).
 *
 * An empty list keeps the fallback. Ids that are not plain names are
 * dropped, and so are efforts not in {@link EFFORTS}.
 */
export function setClaudeModels(list: readonly AgentModel[]): void {
  const clean = list
    .filter(
      (entry) => entry.agent === "claude" && CLAUDE_MODEL_ID.test(entry.id),
    )
    .map((entry) =>
      entry.efforts
        ? { ...entry, efforts: entry.efforts.filter(isEffort) }
        : entry,
    );
  const next = clean.length > 0 ? clean : CLAUDE_MODELS;
  if (JSON.stringify(next) === JSON.stringify(claudeList)) return;
  claudeList = next;
  relist();
}

/**
 * Take `list` as Codex's models, the ones `codex` itself lists.
 *
 * An empty list keeps the fallback. Ids that are not plain names are dropped.
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
  relist();
}

/**
 * Take `list` as OpenCode's models, the ones its service lists (FE-104).
 *
 * Unlike Codex's there is no fallback: an empty list means no OpenCode model
 * can be picked. Ids that are not `provider/model` are dropped.
 */
export function setOpenCodeModels(list: readonly AgentModel[]): void {
  const next = list.filter(
    (entry) => entry.agent === "opencode" && OPENCODE_MODEL_ID.test(entry.id),
  );
  if (JSON.stringify(next) === JSON.stringify(opencodeList)) return;
  opencodeList = next;
  relist();
}

/** Told when one CLI's list changed, so the picker redraws. */
export function onModelsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Every model the picker offers: Claude's, then Codex's current list.
 *
 * The same array until the list changes, so React may compare it as a
 * snapshot.
 */
export function allModels(): readonly AgentModel[] {
  return everyModel;
}

const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Each CLI's default: Codex's and OpenCode's are the first of their lists.
 *
 * NOTE: OpenCode has no fallback id (FE-104): until its list is read it is
 * `""`, which {@link checkSettings} refuses, so no turn runs on a guess.
 */
function defaultModel(agent: ConversationAgent): string {
  switch (agent) {
    case "claude":
      return (
        claudeList.find((entry) => entry.preferred)?.id ??
        (claudeList.some((entry) => entry.id === DEFAULT_MODEL)
          ? DEFAULT_MODEL
          : (claudeList[0]?.id ?? DEFAULT_MODEL))
      );
    case "codex":
      return codexList[0]?.id ?? "gpt-6.1-sol";
    case "opencode":
      return (
        opencodeList.find((entry) => entry.preferred)?.id ??
        opencodeList[0]?.id ??
        ""
      );
  }
}

function isModel(value: unknown): value is string {
  return typeof value === "string" && allModels().some((m) => m.id === value);
}

/**
 * The CLI that runs model `id`; Claude for one not listed.
 *
 * NOTE: A `provider/model` id is OpenCode's even before its list is read
 * (FE-105): Claude's and Codex's ids never hold a slash, and a reopened
 * OpenCode conversation must keep its model rather than fall to "No model".
 */
export function agentOfModel(id: string | null): ConversationAgent {
  const listed = allModels().find((m) => m.id === id)?.agent;
  if (listed) return listed;
  return id && OPENCODE_MODEL_ID.test(id) ? "opencode" : "claude";
}

/** The model's label, or the id as the CLI named it when it is not listed. */
export function modelName(id: string | null): string | null {
  if (!id) return null;
  return allModels().find((m) => m.id === id)?.label ?? id;
}

/**
 * `settings` for a conversation on `agent`.
 *
 * A model of another CLI becomes that agent's default: the last settings used
 * anywhere may be Claude's while this conversation is Codex.
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

function isEffort(value: unknown): value is Effort {
  return (
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
  );
}

/** The efforts `model` takes: every one for a model its CLI never described. */
export function modelEfforts(model: string): readonly Effort[] {
  return allModels().find((m) => m.id === model)?.efforts ?? EFFORTS;
}

/**
 * `effort` on `model`: itself when the model takes it, else the nearest
 * one below it, else its lowest (FE-135/D5). Unchanged for a model that
 * takes none: `--effort` is still passed, and the CLI ignores it.
 */
export function effortFor(model: string, effort: Effort): Effort {
  const levels = modelEfforts(model);
  if (levels.length === 0 || levels.includes(effort)) return effort;
  const at = EFFORTS.indexOf(effort);
  const below = levels.filter((level) => EFFORTS.indexOf(level) < at);
  return below.at(-1) ?? levels[0] ?? effort;
}

/** Whether `model` has a fast mode: yes unless its CLI says it has none. */
export function modelHasFast(model: string): boolean {
  return allModels().find((m) => m.id === model)?.fast !== false;
}

/**
 * `--permission-mode`, as the picker offers it.
 *
 * The CLI's `plan` and `dontAsk` are not offered.
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

/**
 * A settings object from the page, checked field by field.
 *
 * @returns null when any field is not one the lists above allow.
 */
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
  // A model that takes fewer efforts, or has no fast mode, gets what it
  // does take (FE-135/D5).
  return {
    model: v.model,
    effort: effortFor(v.model, v.effort),
    fast: v.fast && modelHasFast(v.model),
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
  /** Its input as pretty JSON, cut at {@link TOOL_TEXT_MAX}. */
  input: string;
  /** Its result as text, cut at {@link TOOL_TEXT_MAX}; null while it runs. */
  output: string | null;
  /**
   * Its result was longer than {@link TOOL_TEXT_MAX}: `output` is only its
   * start, and `toolOutput` reads the whole of it back. Set from a Claude
   * transcript; absent elsewhere.
   */
  outputCut?: boolean;
  /** Its result said it failed. */
  error: boolean;
  /** The file it read or wrote, when it names one, for the file chip. */
  filePath: string | null;
  /** The sub-agent this call spawned, if any; it opens the sub-agent view. */
  subagent: string | null;
  /**
   * When the call was issued, as an ISO time; null when its source tells no
   * time for it.
   */
  startedAt: string | null;
  /**
   * How long it took: its result's time minus {@link startedAt}, in ms, never
   * below 0. Null while it runs, or when either time is unknown.
   */
  durationMs: number | null;
}

/**
 * `end - start` in ms, clamped at 0, for {@link ToolCall.durationMs}; null
 * when either is missing or not a time.
 */
export function spanMs(
  start: string | number | null | undefined,
  end: string | number | null | undefined,
): number | null {
  const from = typeof start === "string" ? Date.parse(start) : start;
  const to = typeof end === "string" ? Date.parse(end) : end;
  if (typeof from !== "number" || typeof to !== "number") return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

/**
 * The most of one tool call's input or output sent to the page, in chars. A
 * longer output goes as its start, {@link ToolCall.outputCut} set.
 */
export const TOOL_TEXT_MAX = 16 * 1024;

/** The most of one tool result `toolOutput` sends back, in chars. */
export const TOOL_OUTPUT_FULL_MAX = 2 * 1024 * 1024;

/** One tool call's whole result, as `toolOutput` reads it back. */
export interface ToolOutput {
  text: string;
  /** Longer than {@link TOOL_OUTPUT_FULL_MAX} even so: `text` is its start. */
  cut: boolean;
}

/** Something the user attached to a prompt: a pasted image, a file. */
export interface Attachment {
  name: string;
  /** `image/png`, `text/plain`… */
  mediaType: string;
  /** A local path main can read back, when the CLI kept one; else null. */
  path: string | null;
  /** Its size in bytes, when known: an image block's, from its data. */
  size?: number;
}

/**
 * An image named in the chat, read back.
 *
 * Its real path and its bytes as a `data:` URL; or, when it is missing or out
 * of scope, the path as asked.
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
  /** The transcript line's uuid: stable, the TOC's anchor (D5). */
  id: string;
  text: string;
  attachments: Attachment[];
  /** When it was sent, as an ISO timestamp. */
  at: string;
  /** The session of a thread it came from ({@link TurnSession}). */
  session?: TurnSession;
}

export interface AssistantTurn {
  role: "assistant";
  /** The first transcript line of the turn. */
  id: string;
  blocks: Block[];
  /** The model that answered, as the CLI names it. */
  model: string | null;
  usage: TurnUsage | null;
  /** When it started, as an ISO timestamp. */
  at: string;
  /** When it last wrote, as an ISO timestamp. */
  endedAt: string | null;
  /** Still being written: the last turn of a working conversation. */
  open: boolean;
  /** The session of a thread it came from ({@link TurnSession}). */
  session?: TurnSession;
}

/**
 * Claude compacted the conversation here (FE-120): its `compact_boundary`
 * line, with the summary it kept. What came before is no longer in the
 * model's context, though the chat still shows it.
 */
export interface CompactionTurn {
  role: "compaction";
  /** The boundary line's uuid. */
  id: string;
  /** `/compact` typed, or the context ran full; null when not said. */
  trigger: "manual" | "auto" | null;
  /** The context's size before and after, in tokens; null when not said. */
  preTokens: number | null;
  postTokens: number | null;
  /** The summary Claude kept in place of what came before. */
  summary: string | null;
  /**
   * The card Lanework's hook asked the agent to checkpoint right after this
   * compaction (FE-117), such as `FE-117`; null when it asked none.
   */
  taskId: string | null;
  /** When it compacted, as an ISO timestamp. */
  at: string;
  /** The session of a thread it came from ({@link TurnSession}). */
  session?: TurnSession;
}

/**
 * Which session of a thread a turn came from (see {@link HandoffTurn}): set
 * only on the turns of a thread that spans more than one session.
 */
export interface TurnSession {
  /** The native session (CLI conversation) id the turn was read from. */
  conversation: string;
  agent: ConversationAgent;
  /** The model it ran on there, when known. */
  model: string | null;
}

/** One side of a handoff marker: a session's agent and model. */
export interface HandoffTurnSide {
  /** The native session id. */
  conversation: string;
  agent: ConversationAgent;
  model: string | null;
}

/**
 * Where a thread was handed to another agent in place (`switchAgent`):
 * drawn between the sessions it joins, never written by a CLI.
 *
 * NOTE: A marker main makes when it stitches a thread's sessions together
 * on `read`; its id is derived from the session it opens, so a page that
 * reads again finds the same one.
 */
export interface HandoffTurn {
  role: "handoff";
  /** `handoff:<the new session's id>`. */
  id: string;
  /** The sessions it continued, oldest first. */
  from: HandoffTurnSide[];
  /** The session it started. */
  to: HandoffTurnSide;
  /** When it was handed off, ISO. */
  at: string;
  /** What the context block carried. */
  carried: HandoffCarried;
  session?: TurnSession;
}

export type Turn = UserTurn | AssistantTurn | CompactionTurn | HandoffTurn;

export interface Conversation {
  /**
   * The conversation's id. For a thread (several sessions joined by
   * `switchAgent`), its head's: the first session's.
   */
  id: string;
  /**
   * The conductor that started it (FE-128) and the access it gives the
   * user, as main knows it; null or absent for any other conversation.
   * Known from the first read, before the rail lists the session.
   */
  launchedBy?: SessionLauncher | null;
  /**
   * Whether that conductor keeps the user out now (`isManaged`), as main
   * gates the user's calls: false once it is gone.
   */
  managed?: boolean;
  /**
   * The CLI whose transcript it is, and that sends its next turn: for a
   * thread, its newest session's.
   */
  agent: ConversationAgent;
  /** The folder it runs in, shown as the composer's "Current checkout". */
  cwd: string | null;
  /** Its git branch when it was last written, for the composer row. */
  branch: string | null;
  turns: Turn[];
  /** A turn is open: the agent is thinking or working. */
  working: boolean;
  /** The card its agent last named to the Lanework MCP, as the rail has it. */
  card: AgentCard | null;
  /**
   * The settings it last ran with here, or null when never sent from chat:
   * for a thread, its newest session's.
   */
  settings: ComposerSettings | null;
  /** Longer than one read takes: its start was dropped, the end kept. */
  truncated: boolean;
  /**
   * How many turns come before `turns`: `read` sends only the newest
   * ({@link windowStart}), and `readBefore` pages back through the rest.
   * 0 or absent: `turns` is all main holds (still `truncated` past
   * {@link CONVERSATION_READ_MAX}).
   */
  earlier?: number;
  /**
   * What the chat would read from turns a window leaves out: set when
   * `earlier` > 0. The page reads its own turns first, and this only when
   * they say nothing.
   */
  summary?: ConversationSummary;
  /**
   * The conversation's last {@link ConversationEvent.seq} when `read`
   * answered: every event up to it went out before this answer did. Absent
   * from anything but `read`.
   */
  seq?: number;
}

/**
 * Facts of a whole conversation, sent with a read that holds only its newest
 * turns ({@link Conversation.summary}).
 *
 * NOTE: Each is what a scan of every turn would answer, so a chat that holds
 * a window answers as one that held them all, without the turns themselves.
 */
export interface ConversationSummary {
  /**
   * The context version its last conductor turn carried (FE-95), or null:
   * a conductor's next turn sends its rules again only when it changed.
   */
  conductorContext: string | null;
  /** The model its last answer came from, or null. */
  model: string | null;
  /** The proposals planned before the window, oldest first (FE-134). */
  proposals: EarlierProposal[];
  /**
   * The turns the newest of {@link proposals} is read from: its planning
   * and repair turns, each reply with its text blocks only. The chat reads
   * the proposal from them as from its own turns (it may be the latest, its
   * card drawn above the prompt), and never draws them. Empty when there is
   * none, or it is too long to send.
   */
  anchor: Turn[];
}

/**
 * A proposal whose planning turn the window leaves out: enough to title its
 * run and keep that run in its place, not at the chat's end.
 */
export interface EarlierProposal {
  id: string;
  /** Its title; empty when its reply did not hold a valid proposal. */
  title: string;
  /** The reply turn its settled run follows, as `DerivedProposal`. */
  afterTurn: string | null;
}

/** The most of a transcript one read takes. */
export const CONVERSATION_READ_MAX = 32 * 1024 * 1024;

/**
 * The most user turns one `read` sends: the newest, with everything after
 * the first of them. Older ones come a page at a time (`readBefore`).
 */
export const CONVERSATION_WINDOW_TURNS = 20;

/**
 * The most of one `read` or `readBefore` page, as {@link turnBytes} counts
 * it. Whichever of this and the user turns' count comes first ends it.
 */
export const CONVERSATION_WINDOW_BYTES = 1024 * 1024;

/** The most user turns one `readBefore` page may ask for. */
export const CONVERSATION_PAGE_TURNS_MAX = 100;

/** How `read` reads: the newest turns, or all of them. */
export interface ConversationReadOptions {
  /**
   * Every turn main holds, not the newest only.
   *
   * NOTE: The whole conversation, up to {@link CONVERSATION_READ_MAX} of
   * transcript, is copied over IPC and into the page: only for a caller that
   * cannot do with a window or a call for small facts (`summary`,
   * `readToolCalls`).
   */
  full?: boolean;
}

/** Turns from before the ones the page holds (`readBefore`). */
export interface ConversationPage {
  /** In order, oldest first; they end right before the turn asked from. */
  turns: Turn[];
  /** How many turns come before these. */
  earlier: number;
}

/**
 * About how many bytes `turn` takes once serialized: its strings' lengths and
 * a little for each field. An estimate for {@link windowStart}, never sent.
 *
 * NOTE: Not `JSON.stringify(turn).length`: that builds a copy of every turn
 * a read looks at, the cost the window is there to save.
 */
export function turnBytes(turn: Turn): number {
  const FIELD = 64;
  if (turn.role === "user")
    return (
      FIELD * 4 +
      turn.text.length +
      turn.attachments.reduce(
        (sum, entry) =>
          sum +
          FIELD +
          entry.name.length +
          entry.mediaType.length +
          (entry.path?.length ?? 0),
        0,
      )
    );
  if (turn.role === "compaction")
    return FIELD * 8 + (turn.summary?.length ?? 0);
  if (turn.role === "handoff") return FIELD * (8 + 4 * turn.from.length);
  let bytes = FIELD * 8 + (turn.model?.length ?? 0);
  for (const block of turn.blocks) {
    if (block.type === "text") bytes += FIELD + block.text.length;
    else if (block.type === "tools")
      for (const call of block.calls)
        bytes +=
          FIELD * 12 +
          call.summary.length +
          call.input.length +
          (call.output?.length ?? 0) +
          (call.filePath?.length ?? 0);
    else bytes += FIELD * 8 + block.request.input.length;
  }
  return bytes;
}

/**
 * Where the newest turns of `turns[0, end)` start: back from `end` until
 * `maxUsers` user turns are in, or the next turn would take it past
 * `maxBytes` ({@link turnBytes}). At least one turn is always in, however
 * large.
 *
 * @returns The first index in; 0 when everything is.
 */
export function windowStart(
  turns: readonly Turn[],
  end = turns.length,
  maxUsers = CONVERSATION_WINDOW_TURNS,
  maxBytes = CONVERSATION_WINDOW_BYTES,
): number {
  let users = 0;
  let bytes = 0;
  let start = end;
  while (start > 0) {
    const turn = turns[start - 1] as Turn;
    const size = turnBytes(turn);
    if (start < end && bytes + size > maxBytes) break;
    bytes += size;
    start--;
    // A window starts on its oldest prompt, never on what answers one.
    if (turn.role === "user" && ++users >= maxUsers) break;
  }
  return start;
}

// ─── Sending ────────────────────────────────────────────────────────────────

/** A file the composer attaches, by the path the OS dialog or a drop gave. */
export type OutgoingAttachment =
  /** A file on disk, by the path `pathForFile` gave for a pick or a drop. */
  | { kind: "path"; path: string }
  /**
   * A pasted image, which has no path: its bytes, base64.
   *
   * Main sends it as an image block; at most {@link PASTE_MAX} bytes decoded.
   */
  | { kind: "data"; name: string; mediaType: string; data: string };

/** The most a pasted image may weigh, decoded. */
export const PASTE_MAX = 5 * 1024 * 1024;

/** What `/` and `@` offer in the composer. */
export type SuggestionKind = "command" | "file";

/** What an `@` suggestion is (FE-93/D2). */
export type ReferenceKind = "file" | "folder";

/** What a `/` suggestion is (FE-92): a skill, a command file, or the CLI's own. */
export type CommandKind = "skill" | "command" | "builtin";

/** Where a `/` suggestion comes from (FE-92): the project, the user, the CLI. */
export type CommandSource = "project" | "personal" | "builtin";

export interface Suggestion {
  /** What is inserted: `/review`, `@src/app.tsx`. */
  value: string;
  /** One line under it: a command's description, a file's folder. */
  detail: string | null;
  /**
   * The name shown: `/better-ui` is "Better UI", `@src/cli.ts` is
   * "cli.ts".
   */
  label?: string;
  kind?: CommandKind | ReferenceKind;
  /** A `/` suggestion's. */
  source?: CommandSource;
}

/** Words a command's name shows in capitals, not title case. */
const ACRONYMS = new Set([
  "ai",
  "api",
  "ci",
  "cli",
  "css",
  "html",
  "json",
  "mcp",
  "pr",
  "sdk",
  "ui",
  "url",
  "ux",
]);

/**
 * A command's name as a person reads it: `/better-ui` is "Better UI",
 * `/frontend:review` is "Frontend Review".
 */
export function commandLabel(value: string): string {
  return value
    .replace(/^\//, "")
    .split(/[-_:\s]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export interface SendRequest {
  project: string;
  conversation: string;
  /**
   * The page's name for this message, so it keeps it while it waits in the
   * queue. Main makes one when absent.
   */
  id?: string;
  text: string;
  attachments: OutgoingAttachment[];
  settings: ComposerSettings;
}

/**
 * A new conversation's first message: main names the conversation.
 *
 * `conductor` makes it that conductor's own conversation in this project
 * (FE-95), replacing the one it had.
 */
export type StartRequest = Omit<SendRequest, "conversation"> & {
  conductor?: string;
};

/**
 * The CLI asked to use a tool (`control_request` / `can_use_tool`) and waits.
 *
 * Shown as a card in the chat; answered with
 * {@link DesktopConversationApi | answerPermission}.
 */
export interface PermissionRequest {
  /** The control request's id. */
  id: string;
  tool: string;
  /** What it would do, in one line: the CLI's `description`, else a summary. */
  summary: string;
  /** Its input as pretty JSON, cut at {@link TOOL_TEXT_MAX}. */
  input: string;
  /** The CLI offers "allow and switch to this mode for the session". */
  suggestMode: Permission | null;
  /**
   * `AskUserQuestion`'s questions, asked before acting.
   *
   * Drawn as a question card instead of Allow/Deny. Null for every other
   * tool.
   */
  questions: AskQuestion[] | null;
}

/** A conversation whose engine waits on the person: a tool, or questions. */
export interface Awaiting {
  project: string;
  conversation: string;
  agent: ConversationAgent;
  /** Oldest first. */
  requests: {
    id: string;
    tool: string;
    summary: string;
    /** `AskUserQuestion`'s first question; null for a tool's permission. */
    question: string | null;
  }[];
  /** ISO time its first request still open was asked. */
  since: string;
}

/** One of `AskUserQuestion`'s questions, as the CLI's input has it. */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** The most answers one reply carries. */
export const ANSWERS_MAX = 8;
/** The longest one answer may be, in characters. */
export const ANSWER_MAX = 2000;

export type PermissionAnswer =
  | {
      behavior: "allow";
      /** Also switch the session to this mode. */
      mode?: Permission;
      /**
       * `AskUserQuestion`'s answers, by question text.
       *
       * Each is an option's label (several joined by ", "), or what was typed
       * under "Something else".
       */
      answers?: Record<string, string>;
    }
  | { behavior: "deny"; message?: string };

/**
 * A message the engine holds back until the CLI can take it.
 *
 * It was sent while the queue was paused, the turn was not ready, or it asked
 * for other settings than the running turn's.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: { name: string; image: boolean }[];
  /** Why it did not go. It stays until sent, edited or removed. */
  error: string | null;
}

/** What the engine holds back, when it holds anything. */
export interface EngineQueue {
  queue?: QueuedMessage[];
  /** Stopped with messages waiting: they go on Resume, or the next send. */
  paused?: boolean;
  /**
   * The running Claude process loads user settings only: Claude has no
   * trust on record for the folder, so the repo's `.claude` settings stay
   * off until the user trusts it in a Claude tab (FE-77/D3).
   */
  untrusted?: true;
}

/**
 * Where a conversation's engine stands.
 *
 * Only one process writes a conversation at a time. `terminal` means a pty is
 * running Claude on it, and the composer stays paused until that tab stops.
 */
export type EngineState =
  | ({ state: "idle" } & EngineQueue)
  | ({ state: "starting" } & EngineQueue)
  | ({ state: "running" } & EngineQueue)
  | { state: "terminal"; terminalId: string }
  | ({ state: "error"; message: string } & EngineQueue);

/**
 * Main → renderer, as a turn streams in.
 *
 * NOTE: Not every window hears every event. `delta`, `turn` and `moved` go
 * in full only to the windows that `subscribe`d to the conversation; the
 * others hear its status: `permission`, `permission-done`, `claude-auth` and
 * a `state` that changes `engine.state` at once, and at most one other
 * `state` and one `moved` (standing for every `turn` and `moved` since) per
 * {@link CONVERSATION_STATUS_MS}. A hidden chat or the rail never pays for
 * streamed text it does not draw.
 */
export type ConversationEvent = (
  | {
      type: "state";
      project: string;
      conversation: string;
      engine: EngineState;
    }
  /** The transcript moved on: read it again (or patch from `turn`). */
  | { type: "turn"; project: string; conversation: string; turn: Turn }
  /**
   * The engine saw the transcript move on (a Codex item finished).
   *
   * The page reads it again without waiting for the file watcher.
   */
  | { type: "moved"; project: string; conversation: string }
  /** Text for the open turn's last text block, before its line lands. */
  | { type: "delta"; project: string; conversation: string; text: string }
  | {
      type: "permission";
      project: string;
      conversation: string;
      request: PermissionRequest;
    }
  /** A pending permission was answered (here or because the turn ended). */
  | {
      type: "permission-done";
      project: string;
      conversation: string;
      id: string;
    }
  /**
   * How Claude's own sign-in fared on the turn that just ended (FE-139).
   *
   * `failed` with the CLI's words when it refused the turn for a sign-in that
   * has to be done again (`claude auth login`); `ok` when a turn went through.
   */
  | {
      type: "claude-auth";
      project: string;
      conversation: string;
      state: "failed" | "ok";
      message: string | null;
    }
) & {
  /**
   * The conversation's own count of events, one higher on each, set by main
   * as the event goes out (absent before it does).
   *
   * A subscribed page drops what it has applied already (`seq` at or below
   * its last) and asks {@link DesktopConversationApi | replay} for the
   * events after its last when one is skipped. A status event standing for
   * several carries the last one's. Counted from 1 again only when the app
   * starts.
   */
  seq?: number;
};

/**
 * Status events, other than a change of `engine.state`, wait up to this
 * long to go to a window not subscribed to their conversation: the latest
 * goes, the rest are dropped.
 */
export const CONVERSATION_STATUS_MS = 250;

/**
 * What `subscribe` and `replay` answer: the conversation's last
 * {@link ConversationEvent.seq}, and the events after the one asked from.
 *
 * `events` is null when main no longer holds them all (it keeps the last
 * few per conversation) or none was asked from: the page reads the
 * conversation, its engine's state and its permissions again instead.
 */
export interface ConversationReplay {
  seq: number;
  events: ConversationEvent[] | null;
}

/**
 * Whether a failed Claude turn's words say its sign-in must be done again
 * (FE-139).
 *
 * The CLI prefixes every 401 and 403 with "Failed to authenticate", a 403
 * from a proxy or Cloudflare's bot check included; those are the network's,
 * and signing in again does not help. Only words that send the person to
 * log in, or name an expired or revoked token, count.
 */
export function needsClaudeSignIn(text: string): boolean {
  return (
    /\bclaude (auth )?login\b/i.test(text) ||
    /\brun \/login\b/i.test(text) ||
    /\bAPI Error: 401\b/.test(text) ||
    /\bOAuth token (has expired|(was )?revoked)\b/i.test(text) ||
    /\bInvalid API key\b/i.test(text)
  );
}

// ─── Usage limits ───────────────────────────────────────────────────────────

/** Which of the account's windows ran out, as far as the CLI said. */
export const USAGE_LIMIT_WINDOWS = [
  "5-hour",
  "weekly",
  "monthly",
  "unknown",
] as const;
export type UsageLimitWindow = (typeof USAGE_LIMIT_WINDOWS)[number];

/**
 * An agent's account ran out of usage: its CLI refused a turn for it.
 *
 * Main keeps one per agent and scope until `resetsAt` passes, or until a
 * turn under it goes through again (bought usage, a banked reset spent).
 */
export interface UsageLimit {
  agent: ConversationAgent;
  /**
   * The model family it caps alone (`opus`, `sonnet`: Claude's weekly
   * per-model caps); null when it caps the whole account.
   */
  scope: string | null;
  window: UsageLimitWindow;
  /** When the window starts over, ISO; null when nothing said. */
  resetsAt: string | null;
  /** The CLI's own words, cut at 500 characters. */
  message: string;
  /** When main saw it, ISO. */
  at: string;
}

/**
 * A conversation main stopped (or saw refused) because its agent hit a
 * usage limit.
 *
 * `autoContinue` says what happens next:
 * - `scheduled`: "Continue where you left off." goes at `continueAt`.
 * - `off`: the conversation is not opted in; it waits for the person.
 * - `unknown-reset`: opted in, but the CLI and the usage readers gave no
 *   reset time, so nothing is sent by itself.
 */
export interface UsageLimitStop {
  agent: ConversationAgent;
  project: string;
  conversation: string;
  autoContinue: "scheduled" | "off" | "unknown-reset";
  /** ISO; set only when `scheduled`. */
  continueAt: string | null;
}

/** What `usageLimits` answers, and every `onUsageLimits` event carries. */
export interface UsageLimitsState {
  /** The limits in force now, one per agent and scope at most. */
  limits: UsageLimit[];
  /** Conversations stopped by a limit and not sent to since. */
  stopped: UsageLimitStop[];
  /** Conversations opted in to auto-continue, stopped or not. */
  autoContinue: { project: string; conversation: string }[];
}

/**
 * Whether a turn on `model` falls under a limit of `scope`.
 *
 * @param unknown What a turn whose model is not known counts as: under the
 *   limit when stopping (it may run on the capped model), not when a turn
 *   that went through is read as the limit gone.
 */
export function inScope(
  scope: string | null | undefined,
  model: string | null | undefined,
  unknown: boolean,
): boolean {
  if (!scope) return true;
  if (!model) return unknown;
  return model.toLowerCase().includes(scope);
}

/**
 * The limit a conversation of `agent` on `model` is under, if any: the
 * whole account's first (no turn goes through it), else its model family's.
 */
export function limitOver(
  limits: readonly UsageLimit[],
  agent: ConversationAgent | null,
  model: string | null | undefined,
): UsageLimit | null {
  if (!agent) return null;
  const own = limits.filter((entry) => entry.agent === agent);
  return (
    own.find((entry) => !entry.scope) ??
    own.find((entry) => inScope(entry.scope, model, false)) ??
    null
  );
}

/** The message an opted-in conversation is sent once its limit resets. */
export const AUTO_CONTINUE_TEXT = "Continue where you left off.";

// ─── Handoff ────────────────────────────────────────────────────────────────

/**
 * Continue a conversation in a NEW one, on another agent (or model).
 *
 * Main reads the source's transcript, carries its latest compaction summary
 * and its most recent turns (under a budget) into a context block, and starts
 * the new conversation with that block followed by `text`.
 */
export interface HandoffRequest {
  project: string;
  /** The conversation handed off from. */
  conversation: string;
  /** The agent to continue on; must be the agent of `model`. */
  agent: ConversationAgent;
  model: string;
  effort: Effort;
  /** Default: false. */
  fast?: boolean;
  /** Default: the source's last settings, else the last used anywhere. */
  permission?: Permission;
  /** The first message the person writes to the new conversation. */
  text: string;
  /** Sent with `text`, as a start's are. Default: none. */
  attachments?: OutgoingAttachment[];
}

/** What a handoff carried from its source's transcript. */
export interface HandoffCarried {
  /** The source's latest compaction summary went in (cut if long). */
  summary: boolean;
  /** Turns since that compaction (or since the start) that went in. */
  turns: number;
  /** Turns since then that did not fit the budget. */
  omitted: number;
  /** The context block's size, in UTF-8 bytes. */
  bytes: number;
}

/**
 * One handoff, old -> new: read for "Handed off from" on the new
 * conversation and "Continued in" on the old one.
 */
export interface ConversationHandoff {
  project: string;
  from: {
    conversation: string;
    agent: ConversationAgent;
    /** The model it last ran with, when known; absent on older links. */
    model?: string | null;
  };
  to: { conversation: string; agent: ConversationAgent; model: string };
  /** When it was handed off, ISO. */
  at: string;
  carried: HandoffCarried;
  /**
   * The source agent's usage limit in force at the time (see
   * {@link UsageLimitsState}), when one was: the likely reason for it.
   */
  limit: UsageLimit | null;
  /**
   * Made in place (`switchAgent`): `to` continues the SAME thread as `from`,
   * not a conversation of its own. Absent for a handoff to a new
   * conversation (`handoff`).
   */
  thread?: boolean;
}

/**
 * Hand a thread to another agent in place: a new native session joins the
 * thread, started with the whole thread's context block, then `text`.
 */
export interface SwitchAgentRequest {
  /** The model to continue on; it picks the agent. */
  model: string;
  effort: Effort;
  /** Default: false. */
  fast?: boolean;
  /** Default: the newest session's last settings, else the last used anywhere. */
  permission?: Permission;
  /** The person's message, sent after the context block. */
  text: string;
  /** Sent with `text`, as a send's are. Default: none. */
  attachments?: OutgoingAttachment[];
}

/** A conversation's handoffs, both ways. */
export interface ConversationHandoffLinks {
  /** The handoff that started this conversation, if one did. */
  from: ConversationHandoff | null;
  /** The handoffs out of this conversation, oldest first. */
  to: ConversationHandoff[];
}

/** Opens the context block a handoff puts before the person's message. */
export const HANDOFF_CONTEXT_OPEN = "<lanework-handoff";
/** Closes it. */
export const HANDOFF_CONTEXT_CLOSE = "</lanework-handoff>";
/** Between the block and the person's message. */
export const HANDOFF_MESSAGE_HEADING = "User message:";

/**
 * Whether `text` opens with one of Lanework's own envelopes: a conductor's
 * (`<lanework_…>`, FE-87) or a handoff's context block. Those are the
 * person's turn; any other leading tag is the CLI's own and is no turn.
 *
 * NOTE: The handoff block's tag has a hyphen, not an underscore: a check for
 * `<lanework_` alone took a handed-off message for the CLI's, so it never
 * showed, and the chat sat on "Sending…".
 */
export function isLaneworkEnvelope(text: string): boolean {
  const start = text.trimStart();
  return (
    start.startsWith("<lanework_") || start.startsWith(HANDOFF_CONTEXT_OPEN)
  );
}

/**
 * A handoff's first message split into its context block and the person's
 * own message, for a chat that shows the block folded.
 *
 * @returns null when `text` does not start with a handoff block.
 */
export function splitHandoffText(
  text: string,
): { context: string; message: string } | null {
  if (!text.startsWith(HANDOFF_CONTEXT_OPEN)) return null;
  const end = text.indexOf(HANDOFF_CONTEXT_CLOSE);
  if (end < 0) return null;
  const context = text.slice(0, end + HANDOFF_CONTEXT_CLOSE.length);
  let message = text.slice(context.length).replace(/^\s+/, "");
  if (message.startsWith(HANDOFF_MESSAGE_HEADING))
    message = message.slice(HANDOFF_MESSAGE_HEADING.length).replace(/^\s+/, "");
  return { context, message };
}

// ─── Links ──────────────────────────────────────────────────────────────────

/** A link's favicon and title, fetched by main and kept on disk by domain. */
export interface LinkPreview {
  url: string;
  /** The page's `<title>`, trimmed; null if it had none or the fetch failed. */
  title: string | null;
  /** A `data:` URL of the icon; null when none was found. */
  icon: string | null;
}

/** An http(s) URL of at most 2048 characters, parsed; null for anything else. */
function webUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** A link main may open in the browser: http(s), with no credentials. */
export function isOpenableUrl(value: unknown): value is string {
  const url = webUrl(value);
  return url !== null && !url.username && !url.password;
}

/**
 * The hosts whose links main previews by itself (FE-79/D4).
 *
 * NOTE: An agent's reply is hostile content: a link to any other host would
 * make main do a DNS lookup and a GET the moment the reply is drawn, a
 * zero-click channel for whatever the agent read. Links to these hosts carry
 * no data to a host the agent chose. Matched exactly: no subdomains.
 */
export const PREVIEW_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "gist.github.com",
]);

/**
 * A URL main's fetcher accepts: an openable link on its scheme's default
 * port, to one of the {@link PREVIEW_HOSTS}.
 */
export function isPreviewUrl(value: unknown): value is string {
  const url = webUrl(value);
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    // The URL parser drops a port that is its scheme's default.
    url.port === "" &&
    PREVIEW_HOSTS.has(url.hostname.toLowerCase())
  );
}

/**
 * Well-known sites whose favicon main fetches, and nothing else of theirs.
 *
 * NOTE: Only `https://<host>/favicon.ico`, never the page: the path and
 * query, where an agent could hide what it read, never leave this Mac. What
 * a fetch tells the host is only that a chat named it, and every one here is
 * a large public site. A host matches itself and its subdomains
 * (`en.wikipedia.org`, `developer.apple.com`). Never a third-party favicon
 * service: that would hand it every host the chats name.
 */
export const FAVICON_HOSTS: readonly string[] = [
  // Lanework's own site, and its docs and app under it
  "lanework.dev",
  // Platforms and code hosts
  "apple.com",
  "google.com",
  "microsoft.com",
  "amazon.com",
  "cloudflare.com",
  "gitlab.com",
  "bitbucket.org",
  "docker.com",
  "vercel.com",
  // Reference and docs
  "wikipedia.org",
  "mozilla.org",
  "w3.org",
  "whatwg.org",
  "web.dev",
  "caniuse.com",
  "python.org",
  "nodejs.org",
  "npmjs.com",
  "typescriptlang.org",
  "react.dev",
  "nextjs.org",
  "electronjs.org",
  "bun.sh",
  "deno.com",
  "rust-lang.org",
  "docs.rs",
  "crates.io",
  "go.dev",
  "kubernetes.io",
  "postgresql.org",
  "sqlite.org",
  // AI vendors
  "anthropic.com",
  "claude.com",
  "openai.com",
  // Q&A and writing
  "stackoverflow.com",
  "stackexchange.com",
  "medium.com",
  "dev.to",
  "reddit.com",
  "ycombinator.com",
  // Video
  "youtube.com",
  "youtu.be",
];

/** Whether `hostname` is one of {@link FAVICON_HOSTS} or under one. */
export function isFaviconHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return FAVICON_HOSTS.some(
    (known) => host === known || host.endsWith(`.${known}`),
  );
}

/**
 * A URL main may fetch the favicon of: https, on the default port, without
 * credentials, to one of the {@link FAVICON_HOSTS}.
 */
export function isFaviconUrl(value: unknown): value is string {
  const url = webUrl(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.port === "" &&
    isFaviconHost(url.hostname)
  );
}

// ─── IPC ────────────────────────────────────────────────────────────────────

/** The idle limits Settings → Power saver offers, in minutes (FE-126). */
export const POWER_MINUTES = [15, 30, 60, 120] as const;
export type PowerMinutes = (typeof POWER_MINUTES)[number];

/**
 * Settings → Power saver (FE-126): whether a chat's engine ends after it has
 * been idle for `minutes`. The next message resumes the conversation.
 */
export interface PowerSettings {
  enabled: boolean;
  minutes: PowerMinutes;
  /** How the app runs `lwk` for its searches (FE-158). */
  lwkMode: LwkMode;
}

/**
 * How the app runs `lwk` for its searches (FE-158/D1a).
 *
 * - `always` (the default, FE-161): one `lwk serve` kept running from app
 *   start; fastest, but its memory stays taken.
 * - `on-demand`: `lwk serve` starts on the first search and ends after 5
 *   idle minutes.
 * - `per-call`: one `lwk` run per search; nothing kept in memory.
 */
export const LWK_MODES = ["always", "on-demand", "per-call"] as const;
export type LwkMode = (typeof LWK_MODES)[number];

/** On, after 30 minutes (FE-126/D3); lwk always running (FE-161). */
const DEFAULT_POWER_SETTINGS: PowerSettings = {
  enabled: true,
  minutes: 30,
  lwkMode: "always",
};

/** Whatever was on disk or sent, with anything unknown at its default. */
export function checkPowerSettings(value: unknown): PowerSettings {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled:
      typeof saved.enabled === "boolean"
        ? saved.enabled
        : DEFAULT_POWER_SETTINGS.enabled,
    minutes: POWER_MINUTES.includes(saved.minutes as PowerMinutes)
      ? (saved.minutes as PowerMinutes)
      : DEFAULT_POWER_SETTINGS.minutes,
    lwkMode: LWK_MODES.includes(saved.lwkMode as LwkMode)
      ? (saved.lwkMode as LwkMode)
      : DEFAULT_POWER_SETTINGS.lwkMode,
  };
}

// ─── What a panel reads of a whole conversation: its web pages ──────────────

/** One page a conversation found or read on the web. */
export interface WebSource {
  url: string;
  /** As the search result named it; null when only the URL is known. */
  title: string | null;
  /** The URL's host, without a leading `www.`. */
  host: string;
  /** The agent read the page itself (WebFetch), not only listed it. */
  fetched: boolean;
}

/** One web search and what it found; `query: null` for pages read directly. */
export interface WebSearch {
  query: string | null;
  /** When it ran, as an ISO timestamp; "" when unknown. */
  at: string;
  sources: WebSource[];
}

/**
 * Small facts of a whole conversation, for a panel that would otherwise read
 * every turn for them (`summary`).
 */
export interface ConversationFacts {
  /** The web searches it ran and pages it read, newest first. */
  web: { searches: WebSearch[]; partial: boolean };
}

/** The most searches and sources one panel shows. */
const WEB_SEARCHES_MAX = 100;
const WEB_SOURCES_MAX = 500;

const WEB_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "WebSearch",
  "web_search",
  "websearch",
]);
const WEB_FETCH_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "webfetch",
  "fetch",
]);

/**
 * `raw` as a web page's address: http or https only, without credentials or
 * a fragment. null for anything else, so no other scheme reaches a click.
 */
function webUrlOf(raw: string): { url: string; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return { url: parsed.href, host: parsed.hostname.replace(/^www\./, "") };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A tool call's input as an object; `{}` when it is not JSON. */
function callInput(call: ToolCall): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(call.input));
  } catch {
    return {};
  }
}

/**
 * The JSON array after `Links:` in a Claude WebSearch result, read by
 * matching brackets: the result goes on in prose after it.
 */
function linksArray(output: string): unknown[] | null {
  const start = output.indexOf("Links: [");
  if (start < 0) return null;
  const open = start + "Links: ".length;
  let depth = 0;
  let quoted = false;
  for (let at = open; at < output.length; at++) {
    const char = output[at];
    if (quoted) {
      if (char === "\\") at++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(output.slice(open, at + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}`]+/g;

/** The pages a search result lists: its links, else every URL in it. */
function pagesIn(output: string): { url: string; title: string | null }[] {
  const links = linksArray(output);
  if (links)
    return links.flatMap((entry) => {
      const { url, title } = asRecord(entry);
      return typeof url === "string"
        ? [
            {
              url,
              title:
                typeof title === "string" && title.trim() ? title.trim() : null,
            },
          ]
        : [];
    });
  return [...output.matchAll(URL_IN_TEXT)].map((match) => ({
    url: match[0].replace(/[.,;:!?]+$/, ""),
    title: null,
  }));
}

/**
 * The web searches `turns` ran and the pages they read, from their own tool
 * calls (a sub-agent's are in its own transcript, not here), newest first. A
 * page read that no search listed goes under `query: null`.
 *
 * NOTE: Main answers this (`summary`), from the fold it keeps, so a panel
 * that wants only these never reads the turns. The renderer's
 * `src/lib/web-sources.ts` holds the same rule for the turns it has; change
 * both together.
 *
 * @returns At most 100 searches and 500 sources, and whether some were left
 *   out.
 */
export function webSourcesOf(turns: readonly Turn[]): {
  searches: WebSearch[];
  partial: boolean;
} {
  const searches: WebSearch[] = [];
  const direct: WebSearch = { query: null, at: "", sources: [] };
  /** Each URL's sources, so a later read marks every listing of it. */
  const byUrl = new Map<string, WebSource[]>();
  let count = 0;
  let partial = false;

  const add = (search: WebSearch, raw: string, title: string | null) => {
    const web = webUrlOf(raw);
    if (!web || search.sources.some((s) => s.url === web.url)) return null;
    if (count >= WEB_SOURCES_MAX) {
      partial = true;
      return null;
    }
    const source: WebSource = { ...web, title, fetched: false };
    search.sources.push(source);
    byUrl.set(web.url, [...(byUrl.get(web.url) ?? []), source]);
    count++;
    return source;
  };

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.type !== "tools") continue;
      for (const call of block.calls) {
        const at = turn.at;
        if (WEB_SEARCH_TOOLS.has(call.tool)) {
          const input = callInput(call);
          const query =
            typeof input.query === "string" ? input.query : call.input.trim();
          const search: WebSearch = { query: query || null, at, sources: [] };
          for (const found of pagesIn(call.output ?? ""))
            add(search, found.url, found.title);
          searches.push(search);
        } else if (WEB_FETCH_TOOLS.has(call.tool) && call.kind === "fetch") {
          const url = callInput(call).url;
          const web = typeof url === "string" ? webUrlOf(url) : null;
          if (!web) continue;
          const listed = byUrl.get(web.url);
          if (listed) for (const source of listed) source.fetched = true;
          else {
            const source = add(direct, web.url, null);
            if (source) source.fetched = true;
            direct.at = at;
          }
        }
      }
    }
  }

  const all = [...searches, ...(direct.sources.length ? [direct] : [])]
    .filter((search) => search.query !== null || search.sources.length > 0)
    .reverse();
  if (all.length > WEB_SEARCHES_MAX) partial = true;
  return { searches: all.slice(0, WEB_SEARCHES_MAX), partial };
}

export const conversationChannels = {
  read: "conversation:read",
  /** Older turns than the page holds, a page at a time. */
  readBefore: "conversation:read-before",
  /** Only the tool calls with some names, from every turn (a summary). */
  readToolCalls: "conversation:read-tool-calls",
  /** Small facts of the whole conversation (its web pages), not its turns. */
  summary: "conversation:summary",
  /** One tool call's whole result, when the read sent only its start. */
  toolOutput: "conversation:tool-output",
  /** Only the id of the latest proposal that waits on the user (FE-95/D4). */
  latestProposal: "conversation:latest-proposal",
  /** Start a NEW conversation with its first message; answers its id. */
  start: "conversation:start",
  send: "conversation:send",
  /** Interrupt the running turn (the Stop button). */
  stop: "conversation:stop",
  /** Drop what is queued behind the running turn; answers how many went. */
  clearQueue: "conversation:clear-queue",
  /** Take one queued message back out, to be edited. */
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
  /** A project's conversations whose engine process is alive (Running). */
  alive: "conversation:alive",
  /** Keep one chat's engine past the idle limit, or let it go (FE-126). */
  keep: "conversation:keep",
  /** A project's conversations kept running past the idle limit (FE-126). */
  kept: "conversation:kept",
  /** Settings → Power saver (FE-126). */
  powerGet: "conversation:power-get",
  powerSet: "conversation:power-set",
  engineState: "conversation:engine-state",
  /** What the engine is waiting on the person for: a tool, or questions. */
  permissions: "conversation:permissions",
  /** Every conversation, in every project, waiting on the person (FE-97). */
  awaiting: "conversation:awaiting",
  /** The last settings used anywhere, for one never sent from chat. */
  lastSettings: "conversation:last-settings",
  /** Claude's models, as `claude` lists them (FE-135). */
  claudeModels: "conversation:claude-models",
  /** Codex's models, as `codex` lists them in its own cache. */
  codexModels: "conversation:codex-models",
  /** OpenCode's models, as its service lists them (FE-104). */
  opencodeModels: "conversation:opencode-models",
  /** The user's own models, sent so main runs them too (FE-146). */
  customModels: "conversation:custom-models",
  linkPreview: "conversation:link-preview",
  /** Slash commands, or files in the project's folder, matching a query. */
  suggest: "conversation:suggest",
  /** Open a link the person clicked in the chat in the OS browser. */
  openLink: "conversation:open-link",
  /** An image the chat names, read back for its lightbox. */
  image: "conversation:image",
  /** That image, opened in the OS's default app. */
  openImage: "conversation:open-image",
  /** Main → renderer: a {@link ConversationEvent}. */
  event: "conversation:event",
  /** Send this window a conversation's events in full, not its status only. */
  subscribe: "conversation:subscribe",
  unsubscribe: "conversation:unsubscribe",
  /** A conversation's events after a `seq`, while main still holds them. */
  replay: "conversation:replay",
  /** The agents' usage limits in force, and who they stopped. */
  usageLimits: "conversation:usage-limits",
  /** Opt one conversation in to (or out of) auto-continue after a limit. */
  setAutoContinue: "conversation:set-auto-continue",
  /** Main → renderer: a {@link UsageLimitsState}, whenever it changes. */
  usageLimitsEvent: "conversation:usage-limits-event",
  /** Continue a conversation in a new one on another agent; answers its id. */
  handoff: "conversation:handoff",
  /** A conversation's handoffs, in and out. */
  handoffLinks: "conversation:handoff-links",
  /**
   * Continue a thread on another agent IN PLACE (a new native session joins
   * it); answers the thread's id.
   */
  switchAgent: "conversation:switch-agent",
} as const;

export interface DesktopConversationApi {
  /**
   * The conversation with its newest turns only: the last
   * {@link CONVERSATION_WINDOW_TURNS} user turns, or
   * {@link CONVERSATION_WINDOW_BYTES} of turns, whichever is less;
   * `earlier` counts the rest. `{ full: true }` sends every turn.
   */
  read: (
    project: string,
    conversation: string,
    options?: ConversationReadOptions,
  ) => Promise<Conversation>;
  /**
   * The turns right before turn `before` (the oldest one the page holds):
   * up to `limit` user turns (default {@link CONVERSATION_WINDOW_TURNS}, at
   * most {@link CONVERSATION_PAGE_TURNS_MAX}) or
   * {@link CONVERSATION_WINDOW_BYTES}, whichever is less.
   *
   * NOTE: A Claude transcript comes from the fold `read` keeps: only lines
   * written since are read from disk.
   *
   * @throws When `before` is no longer one of its turns (the transcript was
   *   rewritten): read it again.
   */
  readBefore: (
    project: string,
    conversation: string,
    before: string,
    limit?: number,
  ) => Promise<ConversationPage>;
  /**
   * Every assistant turn's tool calls named one of `tools` (`WebSearch`,
   * `WebFetch`…), each turn holding only those, in order: what a panel that
   * looks through the whole conversation for some calls needs, without the
   * rest of it.
   */
  readToolCalls: (
    project: string,
    conversation: string,
    tools: readonly string[],
  ) => Promise<AssistantTurn[]>;
  /**
   * Small facts of the whole conversation ({@link ConversationFacts}): what a
   * panel that wants only them asks for instead of every turn.
   *
   * NOTE: A Claude or Codex transcript comes from the fold `read` keeps, and
   * the answer is kept with it: asked again with no line written, nothing is
   * read and nothing recomputed.
   *
   * @throws When the conversation has no transcript.
   */
  summary: (
    project: string,
    conversation: string,
  ) => Promise<ConversationFacts>;
  /**
   * The whole result of tool call `call`, whose read sent only its start
   * ({@link ToolCall.outputCut}). Claude's conversations only.
   *
   * @throws When the call has no long result in the transcript.
   */
  toolOutput: (
    project: string,
    conversation: string,
    call: string,
  ) => Promise<ToolOutput>;
  /**
   * The id of the conversation's latest proposal when it is ready and waits
   * on the user, else null: what `deriveProposals` answers of `read`'s turns
   * with no turn running, `leads` finding the lead each envelope names.
   *
   * NOTE: Main keeps the transcript folded between asks and reads only what
   * was written since, so the rail may ask after every turn.
   */
  latestProposal: (
    project: string,
    conversation: string,
    leads?: readonly TeamLead[],
  ) => Promise<string | null>;
  /**
   * Start a new conversation with `request` as its first message.
   *
   * Main makes the id and answers once the turn has started, not when it ends.
   */
  start: (
    request: StartRequest,
  ) => Promise<{ conversation: string; engine: EngineState }>;
  /** Resolves once queued or started, not when the turn ends. */
  send: (request: SendRequest) => Promise<EngineState>;
  stop: (project: string, conversation: string) => Promise<void>;
  /** Answers how many were dropped: one may have started meanwhile. */
  clearQueue: (project: string, conversation: string) => Promise<number>;
  /** Null when it is no longer queued: it went meanwhile. */
  takeQueued: (
    project: string,
    conversation: string,
    id: string,
  ) => Promise<{ text: string; attachments: OutgoingAttachment[] } | null>;
  removeQueued: (
    project: string,
    conversation: string,
    id: string,
  ) => Promise<boolean>;
  resumeQueue: (project: string, conversation: string) => Promise<void>;
  answerPermission: (
    project: string,
    conversation: string,
    id: string,
    answer: PermissionAnswer,
  ) => Promise<void>;
  fork: (project: string, conversation: string) => Promise<string>;
  takeOver: (project: string, conversation: string) => Promise<EngineState>;
  release: (project: string, conversation: string) => Promise<void>;
  close: (project: string, conversation: string) => Promise<void>;
  alive: (project: string) => Promise<string[]>;
  /** Exempt one chat from the idle limit, until it is stopped (FE-126). */
  keep: (project: string, conversation: string, on: boolean) => Promise<void>;
  /** A project's conversations exempt from the idle limit (FE-126). */
  kept: (project: string) => Promise<string[]>;
  /** Settings → Power saver (FE-126). */
  power: () => Promise<PowerSettings>;
  setPower: (settings: PowerSettings) => Promise<PowerSettings>;
  engineState: (project: string, conversation: string) => Promise<EngineState>;
  /**
   * The requests the engine is still waiting on.
   *
   * For a page that opens after they were asked: `permission` events reach
   * only the pages already open.
   */
  permissions: (
    project: string,
    conversation: string,
  ) => Promise<PermissionRequest[]>;
  /**
   * Every conversation an engine is waiting on the person in, for the rail's
   * ping and the island (FE-97). Kept current by `permission` and
   * `permission-done` events after this first read.
   */
  awaiting: () => Promise<Awaiting[]>;
  lastSettings: () => Promise<ComposerSettings>;
  /**
   * Claude's models as main last had `claude` list them (FE-135), or the
   * fixed list before it has.
   */
  claudeModels: () => Promise<AgentModel[]>;
  /** Tell main the user's own models (FE-146), so a turn may run on one. */
  setCustomModels: (models: CustomModel[]) => Promise<void>;
  /** Codex's models, read from `~/.codex/models_cache.json` by main. */
  codexModels: () => Promise<AgentModel[]>;
  /**
   * OpenCode's models, asked of its service by main (FE-104); empty when
   * OpenCode is missing, older than 2.0.15, or its service cannot start.
   */
  opencodeModels: () => Promise<AgentModel[]>;
  /**
   * `agent` picks whose `/` commands are listed (FE-105/D3); none is
   * Claude's.
   */
  suggest: (
    project: string,
    kind: SuggestionKind,
    query: string,
    agent?: ConversationAgent | null,
  ) => Promise<Suggestion[]>;
  linkPreview: (url: string) => Promise<LinkPreview>;
  /**
   * Open a clicked link in the OS browser: http(s) only, no credentials.
   *
   * NOTE: Its own channel, not `window.open`. The window's popup handler
   * stays GitHub-only (`external-links.spec.ts`), and only a click in the
   * chat reaches this.
   */
  openLink: (url: string) => Promise<void>;
  /**
   * The image a chat badge names, as a `data:` URL.
   *
   * The name may be `details.png`, `assets/x.png` or an attached
   * `/tmp/…/1.png`. Main reads only the project's folder and the
   * conversation's own attachments.
   */
  image: (
    project: string,
    conversation: string,
    path: string,
  ) => Promise<ImagePreview>;
  /** That image in the OS's default app; the same scope as `image`. */
  openImage: (
    project: string,
    conversation: string,
    path: string,
  ) => Promise<void>;
  /** A path for a dropped or pasted `File`, as Electron knows it. */
  pathForFile: (file: File) => string;
  /**
   * Every event this window hears: in full for the conversations it
   * subscribed to, their status only for the rest
   * ({@link ConversationEvent}).
   */
  onEvent: (listener: (event: ConversationEvent) => void) => () => void;
  /**
   * Send this window `conversation`'s events in full (`delta`, `turn`,
   * `moved`), not its status only, until `unsubscribe`. Counted: each
   * subscribe wants its own unsubscribe. A window that closes or loads
   * another page is let go of by main.
   *
   * With `after`, also answers the events since that `seq`, as `replay`.
   */
  subscribe: (
    project: string,
    conversation: string,
    after?: number | null,
  ) => Promise<ConversationReplay>;
  unsubscribe: (project: string, conversation: string) => Promise<void>;
  /**
   * The events of `conversation` after `seq` `after`, for a page that
   * skipped one; null `events` when main no longer holds them all.
   */
  replay: (
    project: string,
    conversation: string,
    after: number,
  ) => Promise<ConversationReplay>;
  /** The usage limits in force, and the conversations they stopped. */
  usageLimits: () => Promise<UsageLimitsState>;
  /**
   * Send "Continue where you left off." to this conversation once a usage
   * limit that stopped it resets. Kept in memory only: a restart forgets it.
   */
  setAutoContinue: (
    project: string,
    conversation: string,
    on: boolean,
  ) => Promise<UsageLimitsState>;
  /** Every change to {@link UsageLimitsState}, whole. */
  onUsageLimits: (listener: (state: UsageLimitsState) => void) => () => void;
  /**
   * Start a new conversation on `request.agent` that continues
   * `request.conversation`: its context block, then `request.text`.
   *
   * Answers the new conversation's id once its first turn has started (as
   * `start` does); the link is recorded by then. The source is left as it is.
   */
  handoff: (request: HandoffRequest) => Promise<string>;
  /** Where `conversation` was handed off from, and where it was continued. */
  handoffLinks: (
    project: string,
    conversation: string,
  ) => Promise<ConversationHandoffLinks>;
  /**
   * Continue `thread` on `request.model`'s agent in the SAME conversation:
   * a new native session starts with the context block of the whole
   * thread's recent turns, then `request.text`, and joins the thread as its
   * newest session. `read` then shows every session in order, a
   * `handoff` turn between each two.
   *
   * Answers the thread's id (its head's, the first session's), never the
   * new session's, once the new session's first turn has started.
   *
   * @throws While the thread's newest session runs a turn.
   */
  switchAgent: (
    project: string,
    thread: string,
    request: SwitchAgentRequest,
  ) => Promise<string>;
}

/** An `@` mention: quoted when its path has a space (`@"/a b/c.csv"`). */
export const MENTION = /(?<=^|\s)@(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;

/**
 * `text` with each path mention as the file's name: a prompt's title on the
 * rail and in the window reads `c.csv`, not `@"/Users/me/a b/c.csv"`. A
 * mention with no `/` or `.` in it (a conductor's id) stays as written.
 */
export function mentionsAsNames(text: string): string {
  return text.replace(MENTION, (whole, quoted?: string, bare?: string) => {
    const path = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : bare;
    if (!path || !/[./]/.test(path)) return whole;
    return path.replace(/\/+$/, "").split("/").pop() || path;
  });
}
