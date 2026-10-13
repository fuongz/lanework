/**
 * The terminal panel's contract (FE-19): what the renderer may ask of the pty
 * host, and what comes back.
 *
 * ⚠️ The renderer never names a command, a shell or a folder. It names a
 * WORKSPACE, and main resolves the folder a terminal opens in from the links
 * it wrote down itself; the host picks the shell from the environment. A
 * compromised renderer can type into a terminal it was shown, which is what a
 * terminal is for — it cannot start one somewhere else.
 */

/**
 * What a tab is opened as: a plain shell, or a shell with an agent's CLI typed
 * into it (FE-19, the + menu).
 *
 * ⚠️ A NAME, never a command. The renderer picks one of these; the host maps
 * it to the one CLI it stands for, so no command line ever crosses from the
 * page (FE-19/D8).
 */
export const TERMINAL_KINDS = ["shell", "claude", "codex"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

/** The kinds that are an agent's CLI — offered only where this machine has it. */
export type TerminalAgent = Exclude<TerminalKind, "shell">;
export const TERMINAL_AGENTS: readonly TerminalAgent[] = ["claude", "codex"];

export function isTerminalKind(value: unknown): value is TerminalKind {
  return (
    typeof value === "string" &&
    (TERMINAL_KINDS as readonly string[]).includes(value)
  );
}

/** One terminal, as the panel lists it. */
export interface TerminalSession {
  id: string;
  /** The workspace it belongs to: the cloud id, or the slug when there is none. */
  workspace: string;
  /** What it was opened as; an agent tab is still a shell underneath. */
  kind: TerminalKind;
  /** The shell's name — `zsh`, `bash` — for the tab. */
  shell: string;
  /** Where it started, or null when the project has no folder here (`~`). */
  cwd: string | null;
  pid: number;
  /** Epoch ms. */
  createdAt: number;
  /** Set once the shell has exited; the tab stays until it is closed. */
  exit: { code: number; signal: number | null } | null;
  /**
   * The agent conversation this tab is on NOW (FE-31): the one it resumed
   * (FE-23), or a new Claude tab's `--session-id` — then kept up to date by
   * main as the CLI moves (`/clear`, `/resume`, a new Codex's first rollout).
   * Null for a shell, or a new Codex tab nobody has typed into yet.
   */
  resume: string | null;
  /**
   * The card this tab was started to work (FE-34): its task id, or its uuid
   * when it has none. Null for every other tab. Set once, at spawn; which card
   * the agent is on LATER is `AgentSession.card`, read from its transcript.
   */
  card: string | null;
}

/**
 * How an agent is briefed on the card it was handed (FE-34): `work` it end to
 * end — its decisions are settled — or `review` the open ones with the person
 * first (FE-34/D6, the BE-14 flow), then work it.
 */
export const CARD_BRIEFS = ["work", "review"] as const;
export type CardBriefMode = (typeof CARD_BRIEFS)[number];

/**
 * What the renderer may say about the card a new agent tab is for (FE-34/D3).
 *
 * ⚠️ A card's NAME and a mode, never words for the prompt. The host writes
 * the prompt from a fixed template, and the board comes from main's own
 * knowledge of the workspace — nothing typed into the CLI crosses from the
 * page except an id `isCardRef` accepts.
 */
export interface CardBrief {
  /** The card's task id (`FE-34`), or its uuid when it has none. */
  card: string;
  mode: CardBriefMode;
}

const TASK_ID = /^[A-Z]{1,6}-\d{1,5}$/;

/**
 * Whether `value` can be put in an agent's first prompt as a card: a task id
 * or a uuid.
 *
 * ⚠️ The only two shapes, for the reason `isAgentSessionId` has one: the
 * prompt is TYPED into a shell, and letters, digits and dashes are nothing a
 * shell reads as syntax.
 */
export function isCardRef(value: unknown): value is string {
  return typeof value === "string" && (TASK_ID.test(value) || UUID.test(value));
}

/** A board's id — the cloud workspace's — as the host puts it in a prompt. */
export function isBoardId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isCardBrief(value: unknown): value is CardBrief {
  if (!value || typeof value !== "object") return false;
  const { card, mode } = value as Record<string, unknown>;
  return (
    isCardRef(card) &&
    typeof mode === "string" &&
    (CARD_BRIEFS as readonly string[]).includes(mode)
  );
}

/**
 * One conversation an agent's CLI kept on disk for a project's folder (FE-23):
 * what the rail's Agents group lists, and what a click resumes.
 */
export interface AgentSession {
  /** The CLI's own conversation id — always a UUID (`isAgentSessionId`). */
  id: string;
  agent: TerminalAgent;
  /** What the rail shows: the name given in Lanework, else `cliTitle`. */
  title: string;
  /**
   * Its title as the CLI named it, or its first prompt (FE-23). Kept beside
   * `title` so a rename can be undone back to it (FE-24).
   */
  cliTitle: string;
  /** When it was last written to, ISO. */
  updatedAt: string;
  /** When it was pinned, epoch ms, or null (FE-25). */
  pinnedAt: number | null;
  /**
   * Whether its agent is thinking or working right now: a turn is open in
   * the transcript (FE-25). Not "was written lately" — opening a
   * conversation writes to it too.
   */
  working: boolean;
  /**
   * The card its agent last named to the Lanework MCP — read only while it is
   * working, null otherwise or when it never named one (FE-27).
   */
  card: AgentCard | null;
  /** The agents it spawned, newest first (FE-33); none for most. */
  subagents: AgentSubagent[];
  /** How many tasks it started in the background (FE-42); Claude only. */
  background: BackgroundCount;
}

/** A conversation's background tasks, counted for the rail (FE-42). */
export interface BackgroundCount {
  running: number;
  total: number;
}

/**
 * What a background task is (FE-42): a shell `Bash` left running, an agent
 * that runs on its own, or a `Monitor` watching a stream.
 */
export type BackgroundTaskKind = "shell" | "agent" | "monitor";

/**
 * Where a background task stands (FE-42). `lost`: its conversation stopped
 * long ago and no notification ever came — the CLI that owned it is gone.
 */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "lost";

/**
 * A task a Claude conversation started in the background (FE-42), read from
 * its transcript: the call, the id its result named, and the
 * `<task-notification>` that closed it, if one came.
 */
export interface BackgroundTask {
  /** The CLI's task id — `backgroundTaskId`, or an async agent's `agentId`. */
  id: string;
  /** The `tool_use` that started it. */
  toolUseId: string;
  kind: BackgroundTaskKind;
  /** What it was started for, as its caller described it. */
  description: string;
  /** A shell's or monitor's command, cut at `BACKGROUND_COMMAND_MAX`; else null. */
  command: string | null;
  /** An agent's sub-agent id (`agent-<id>.jsonl`), for its viewer; else null. */
  subagentId: string | null;
  status: BackgroundTaskStatus;
  /** A shell's exit code as its notification said it, else null. */
  exitCode: number | null;
  /** The notification's one-line summary, or null before one came. */
  summary: string | null;
  /** When it was started, ISO. */
  startedAt: string;
  /** When its notification came, ISO; null while running or lost. */
  endedAt: string | null;
  /**
   * The pid leading a running shell's or monitor's process group (FE-56),
   * when exactly one process is found for it; null otherwise. Always null for
   * an agent: it runs inside the CLI's own process.
   */
  pid: number | null;
}

/** The most of a shell's command a task carries, in characters. */
export const BACKGROUND_COMMAND_MAX = 4 * 1024;

/** The most of a task's output one read sends, in bytes — its end. */
export const BACKGROUND_OUTPUT_MAX = 64 * 1024;

/**
 * The end of a background shell's output (FE-42/D5), escape codes stripped.
 * `missing`: the CLI's file is gone, or never was where it said.
 */
export interface BackgroundTaskOutput {
  text: string;
  /** The whole file's size, in bytes. */
  size: number;
  /** `text` is only the file's last `BACKGROUND_OUTPUT_MAX` bytes. */
  truncated: boolean;
  missing: boolean;
}

/**
 * Whether `value` can name a background task: the CLI's ids are short
 * letters and digits. Same rule as a sub-agent id — one file name, no `.`.
 */
export function isBackgroundTaskId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_SUBAGENT_ID.test(value);
}

/**
 * An agent a conversation spawned (FE-33): a Claude sub-agent, or a thread a
 * Codex conversation spawned. Shown under its conversation's row.
 *
 * ⚠️ Never resumed on its own — a Claude sub-agent is a sidechain of its
 * conversation — so its id is a key for the rail and never reaches a command
 * line. Nested ones are flattened under the conversation at the root
 * (FE-33/D6).
 */
export interface AgentSubagent {
  /** Unique within its conversation: Claude's `agent-<id>`, a Codex thread id. */
  id: string;
  /** What it was asked to do, as its spawner described it. */
  title: string;
  /** Its kind as the CLI names it — `Explore`, `general-purpose` — or null. */
  type: string | null;
  /** When it was last written to, ISO. */
  updatedAt: string;
  /** Whether it is still going: its last word is not a finished answer. */
  working: boolean;
}

const CLAUDE_SUBAGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether `value` can name a Claude sub-agent's transcript: the `<id>` of
 * `agent-<id>.jsonl`, the same shape the listing reads off the file's name
 * (FE-35/D10).
 *
 * ⚠️ Letters, digits, `_` and `-` only: never a `.` or a separator, so it is
 * one file name and can climb out of no folder.
 */
export function isClaudeSubagentId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_SUBAGENT_ID.test(value);
}

/**
 * One tool call a sub-agent made (FE-35/D3): its name, a line saying what it
 * was called on, and its input as JSON for a closer look. The result is
 * never carried over — only whether it was an error.
 */
export interface SubagentStep {
  tool: string;
  /** The input it was called on, in brief: a path, a pattern, a command's first line. */
  summary: string;
  /** Its input, as pretty JSON — cut at `SUBAGENT_INPUT_MAX`. */
  input: string;
  /** Its result said it failed. */
  error: boolean;
}

/** The most of one step's input JSON a viewer is sent, in characters. */
export const SUBAGENT_INPUT_MAX = 8 * 1024;

/**
 * A sub-agent's transcript, read for the viewer (FE-35): what it was asked,
 * the tools it called, and what it reported back.
 */
export interface SubagentTranscript {
  /** What it was asked to do, as its spawner described it. */
  title: string;
  /** Its kind as the CLI names it — `Explore`, `fork` — or null. */
  type: string | null;
  /** The model its CLI ran it on, as the CLI names it, or null. */
  model: string | null;
  /** Its first and latest line, ISO; null when it has none. */
  startedAt: string | null;
  endedAt: string | null;
  working: boolean;
  /** What it was told; null when the CLI keeps that sealed (a Codex thread). */
  prompt: string | null;
  steps: SubagentStep[];
  /** What it handed back; null while it works, or when it ended without one. */
  report: string | null;
  /**
   * The transcript was longer than one read takes (FE-35/D10): its start and
   * its end were read, and the steps in between are missing.
   */
  truncated: boolean;
}

/** What a conversation's edits did to a file, all told (FE-39). */
export type AgentFileOp = "added" | "modified" | "deleted" | "renamed";

/**
 * One file a conversation edited (FE-39): what the agent view's Files list
 * shows a row for.
 *
 * ⚠️ Only what the CLI's own FILE TOOLS did — Claude's `Edit`, `Write`,
 * `MultiEdit` and `NotebookEdit`, Codex's `apply_patch`. A file changed
 * through the shell (`sed`, a script, a formatter, codegen) is in no
 * transcript, so its absence here says nothing about whether the agent
 * touched it.
 */
export interface AgentFileTouch {
  /** From the repository's top level, `/`-separated — as Changes names it. */
  path: string;
  op: AgentFileOp;
  /** How many times it was edited, its sub-agents' edits included. */
  edits: number;
  /** When it was last edited, ISO. */
  lastAt: string;
  /**
   * The sub-agent that edited it, when the conversation itself never did
   * (FE-39/D5): its id, and its kind as the CLI names it — `Explore`,
   * `general-purpose`, a Codex thread's role — or null.
   */
  via: { id: string; type: string | null } | null;
}

/** A conversation's edited files, newest edit first (FE-39). */
export interface AgentFiles {
  files: AgentFileTouch[];
  /**
   * A transcript was longer than one scan reads: its newest part was read,
   * and edits before that may be missing.
   */
  partial: boolean;
}

/** A conversation that edited a file since HEAD's commit (FE-39/D2). */
export interface AgentFileMark {
  agent: TerminalAgent;
  id: string;
  /** What the rail calls it: its Lanework name, else the CLI's title. */
  title: string;
  /** Its newest edit of the file, ISO. */
  lastAt: string;
  via: AgentFileTouch["via"];
}

/**
 * Which conversations edited each file since HEAD's commit (FE-39/D2, D3) —
 * the marks on Changes. Keyed by `AgentFileTouch.path`, newest edit first.
 */
export interface AgentFileMarks {
  files: Record<string, AgentFileMark[]>;
  partial: boolean;
}

/**
 * One conversation's numbers, read from the end of its transcript for the
 * agent view (FE-38). Each is null when the CLI wrote none — never a 0
 * standing in for "not known" (FE-38/D1).
 */
export interface AgentFacts {
  agent: TerminalAgent;
  /** The model its newest answer came from, as the CLI names it. */
  model: string | null;
  /** Codex only: the reasoning effort its newest turn ran at. */
  effort: string | null;
  /**
   * Claude only: what the conversation would have cost at API prices — an
   * estimate, NOT what a subscription is billed — as Claude last saved it
   * (`cost-state`). Its sub-agents' spend is in it (FE-38/V5).
   */
  costUSD: number | null;
  /**
   * Claude answered again after it last saved its totals: `costUSD`,
   * `lines` and `duration` are as of then. Claude saves them when it is
   * left or quit, not after every turn.
   */
  stale: boolean;
  /**
   * Tokens in and out over the whole conversation; `cached` is the part of
   * `input` read from the cache.
   */
  tokens: { input: number; output: number; cached: number } | null;
  /**
   * What its newest turn sent the model, in tokens — and the model's window,
   * only when the CLI records it: Codex does, Claude does not (FE-38/D2).
   */
  context: { tokens: number; window: number | null } | null;
  /** Claude only: lines its edits added and removed. */
  lines: { added: number; removed: number } | null;
  /**
   * Claude only, in ms: how long its CLI ran (`wall`), and of that how long
   * it waited on the model and ran tools.
   */
  duration: { wall: number; api: number; tools: number } | null;
  /**
   * Claude's own newest recap of it (`away_summary`) and when it wrote it;
   * none for Codex, or with recap off in Claude's `/config` (FE-38/D4).
   */
  recap: { text: string; at: string | null } | null;
  /**
   * The read stopped at `AGENT_FACTS_READ_MAX` before the transcript's
   * start: what it did not reach is null (FE-38/V2).
   */
  partial: boolean;
}

/** The most of one transcript a facts read takes, from its end (FE-38). */
export const AGENT_FACTS_READ_MAX = 4 * 1024 * 1024;

/** One agent's totals over a window of days (FE-38/D6). */
export interface AgentUsageTotals {
  /** Conversations written to in the window; a Codex thread's spawns are not counted. */
  conversations: number;
  /** Claude only: the sum of each conversation's `AgentFacts.costUSD`. */
  costUSD: number | null;
  input: number;
  output: number;
}

/**
 * A project's agent usage over the last 7 and 30 days (FE-38/D6): each
 * conversation written to in the window counts whole.
 */
export interface AgentUsage {
  windows: {
    days: number;
    claude: AgentUsageTotals;
    codex: AgentUsageTotals;
  }[];
  /** Transcripts too long to total in one read, left out of the sums. */
  skipped: number;
}

export const AGENT_USAGE_DAYS = [7, 30] as const;

/**
 * A conversation's transcript settled a write (FE-38): pushed for EVERY
 * settled write, unlike `AgentActivity`, so a view showing its numbers
 * reads them again. At most one per conversation per settle window.
 */
export interface AgentWrite {
  workspace: string;
  agent: TerminalAgent;
  id: string;
  /** Epoch ms. */
  at: number;
}

/**
 * A card an agent is on, as its latest Lanework MCP call named it (FE-27/D1).
 *
 * ⚠️ `card` is what the AGENT typed — a task id (`FE-27`) or a card's uuid —
 * so a renderer matches it against both, and only on the board `boardId`
 * names. Read from the agent's own transcript; nothing is asked of the cloud.
 */
export interface AgentCard {
  boardId: string;
  card: string;
}

/**
 * A transcript changed, and this is whether its agent is now working
 * (FE-25): a turn opened or closed.
 *
 * ⚠️ Pushed by main from a file watcher, never polled — the id straight from
 * the file's name, the state from the transcript's end, so marking a row
 * does not re-read the listing.
 */
export interface AgentActivity {
  workspace: string;
  agent: TerminalAgent;
  id: string;
  working: boolean;
  /** The card it is on, as `AgentSession.card` (FE-27). */
  card: AgentCard | null;
  /**
   * Set when it is one of `id`'s sub-agents that was written, not `id`
   * itself (FE-33): `working` is then that sub-agent's, and `card` null.
   */
  subagent: string | null;
  /** Epoch ms. */
  at: number;
}

/** One of the Codex account's usage windows, as a rollout reported it (FE-41). */
export interface CodexQuotaWindow {
  /** How much of it is used, 0–100. */
  usedPercent: number;
  /** How long it runs: 300 is the 5-hour one, 10080 the week. */
  windowMinutes: number;
  /** When it starts over, epoch ms. */
  resetsAt: number;
}

/**
 * The Codex account's usage, as the newest Codex turn on this machine
 * reported it (FE-41/D1).
 *
 * ⚠️ The ACCOUNT's, not a project's, and only as fresh as that turn: read
 * from a rollout's last `token_count`, never asked of OpenAI. A window past
 * its `resetsAt` says nothing any more (FE-41/D3).
 */
export interface CodexQuota {
  /** The short window — 5 hours today. */
  primary: CodexQuotaWindow | null;
  /** The long one — a week today. */
  secondary: CodexQuotaWindow | null;
  /** The plan as Codex names it — `plus`, `pro` — or null. */
  plan: string | null;
  /** When the turn that reported it was, ISO. */
  at: string;
}

/** A goal's state, as Codex's own `thread_goals` table allows (FE-41). */
export const CODEX_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
] as const;
export type CodexGoalStatus = (typeof CODEX_GOAL_STATUSES)[number];

export function isCodexGoalStatus(value: unknown): value is CodexGoalStatus {
  return (
    typeof value === "string" &&
    (CODEX_GOAL_STATUSES as readonly string[]).includes(value)
  );
}

/** The goal a Codex conversation was given (`/goal`), as Codex keeps it (FE-41/D4). */
export interface CodexGoal {
  objective: string;
  status: CodexGoalStatus;
  /** Tokens it may spend; null when it has no budget. */
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  /** When Codex last changed it, epoch ms. */
  updatedAt: number;
}

/** A Claude account limit window, without any authentication material (FE-46). */
export interface ClaudeQuotaWindow {
  /** How much of it is used, 0–100. */
  usedPercent: number;
  /** 300 for the 5-hour window; 10080 for the 7-day window. */
  windowMinutes: number;
  /** When it starts over, epoch ms; null when the source does not say. */
  resetsAt: number | null;
}

/**
 * Where Claude usage came from (FE-53): `oauth` is Claude's own usage endpoint,
 * read by main with the CLI's credential; `statusline` is the last
 * `rate_limits` a Claude statusline reported.
 */
export const CLAUDE_USAGE_SOURCES = ["oauth", "statusline"] as const;
export type ClaudeUsageSource = (typeof CLAUDE_USAGE_SOURCES)[number];

/**
 * Why the newest fetch did not produce fresh usage (FE-53). The values shown
 * alongside it, if any, are the last known ones.
 * - `expired`: the Claude login has expired — sign in to Claude again.
 * - `unavailable`: there is no Claude login or no source to read.
 * - `failed`: the request or its answer failed (network, rate limit, shape).
 */
export const CLAUDE_USAGE_ERRORS = [
  "expired",
  "unavailable",
  "failed",
] as const;
export type ClaudeUsageError = (typeof CLAUDE_USAGE_ERRORS)[number];

export function isClaudeUsageError(value: unknown): value is ClaudeUsageError {
  return (
    typeof value === "string" &&
    (CLAUDE_USAGE_ERRORS as readonly string[]).includes(value)
  );
}

/**
 * Safe, serialized Claude account usage for the footer (FE-46).
 * Only account metadata and usage cross to the renderer: never credentials,
 * raw auth responses, email addresses, or tokens. Missing windows do not
 * imply zero usage; an auth-only result can still identify the plan.
 */
export interface ClaudeUsage {
  /** The 5-hour window, when available. */
  primary: ClaudeQuotaWindow | null;
  /** The 7-day window, when available. */
  secondary: ClaudeQuotaWindow | null;
  /** The subscription name reported by Claude, or null when unknown. */
  plan: string | null;
  /** The authentication mode reported by Claude, or null when unknown. */
  authMode: string | null;
  /** When usage was successfully fetched, ISO; null for auth-only results. */
  at: string | null;
  /** The cache is older than the freshness threshold; values are last known. */
  stale: boolean;
  /** Which source the windows came from (FE-53); absent/null when none did. */
  source?: ClaudeUsageSource | null;
  /**
   * When main last tried to fetch usage, epoch ms, success or not (FE-53);
   * `at` stays the time of the last successful fetch.
   */
  fetchedAt?: number | null;
  /** Why the newest fetch failed (FE-53); absent/null when it succeeded. */
  error?: ClaudeUsageError | null;
}

/** What `codexUsage` answers for a workspace (FE-41, FE-46). */
export interface CodexUsage {
  quota: CodexQuota | null;
  /** By thread id — only the workspace's listed Codex conversations'. */
  goals: Record<string, CodexGoal>;
  /** Claude account metadata and limits, when available (FE-46). */
  claude?: ClaudeUsage | null;
}

/** The longest name a session may be given in Lanework. */
export const AGENT_NAME_MAX = 120;

export const AGENT_SESSION_LIMIT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can be put on a command line as a conversation id.
 *
 * ⚠️ The only shape a resume id may take: it is TYPED into a shell, so
 * anything but hex and dashes would be a way to type something else.
 */
export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const TERMINAL_LIMITS = {
  /** Tabs per workspace, exited ones included — they still hold a tab. */
  perWorkspace: 8,
  /** Columns and rows are clamped to 1…this. */
  maxGeometry: 1000,
  /** Lines the host keeps per terminal, and replays on re-attach. */
  scrollback: 5000,
  /** The most one input message may carry (a paste), in characters. */
  maxInput: 256 * 1024,
} as const;

export const terminalChannels = {
  /** Renderer → main: send me a port to the pty host. */
  connect: "terminal:connect",
  /** Main → renderer: the port, as a transferred MessagePort. */
  port: "terminal:port",
  /** Main → renderer: the host went away; every session with it. */
  hostExited: "terminal:host-exited",
  list: "terminal:list",
  spawn: "terminal:spawn",
  kill: "terminal:kill",
  reorder: "terminal:reorder",
  /** Which agent CLIs this machine has, for the + menu. */
  agents: "terminal:agents",
  /** The agent conversations kept for a workspace's folder (FE-23). */
  agentSessions: "terminal:agent-sessions",
  /** Name a conversation in Lanework only (FE-24/D1). */
  agentSessionRename: "terminal:agent-sessions:rename",
  /** Pin a conversation to the top of the group, or unpin it (FE-25). */
  agentSessionPin: "terminal:agent-sessions:pin",
  /** One sub-agent's transcript, for the viewer (FE-35). */
  agentSubagent: "terminal:agent-subagent",
  /** A Claude conversation's background tasks (FE-42). */
  agentBackgroundTasks: "terminal:agent-background-tasks",
  /** The end of one background shell's output (FE-42/D5). */
  agentTaskOutput: "terminal:agent-task-output",
  /** Stop one running background shell (FE-43). */
  agentStopTask: "terminal:agent-stop-task",
  /** One conversation's numbers, for the agent view and the rail (FE-38). */
  agentFacts: "terminal:agent-facts",
  /** A project's agent usage over 7 and 30 days, for Settings (FE-38/D6). */
  agentUsage: "terminal:agent-usage",
  /** Main → renderer: a conversation's transcript settled a write (FE-38). */
  agentWritten: "terminal:agent-written",
  /** The files one conversation edited (FE-39/D1). */
  agentFiles: "terminal:agent-files",
  /** Which conversations edited each changed file, for Changes (FE-39/D2). */
  agentFilesForWorktree: "terminal:agent-files-for-worktree",
  /** Main → renderer: a transcript was written (FE-25). */
  agentActivity: "terminal:agent-activity",
  /** The Codex account's usage, and its conversations' goals (FE-41). */
  codexUsage: "terminal:codex-usage",
  /** Fetch Claude account usage now, past the cache (FE-53). */
  refreshClaudeUsage: "terminal:refresh-claude-usage",
  /** Main → renderer: a View-menu command. */
  command: "terminal:command",
} as const;

/** What the View menu can ask the panel to do. */
export type TerminalCommand =
  | "toggle"
  | "new"
  | {
      type: "focus";
      workspace: string;
      slug: string;
      href: string;
      shellId?: string;
    };

/** Renderer → host, over the port. */
export type TerminalClientMessage =
  | { t: "attach"; id: string; cols: number; rows: number }
  | { t: "detach"; id: string }
  | { t: "input"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number };

/** Host → renderer, over the port. */
export type TerminalHostMessage =
  /** The whole screen and scrollback of a session, once, on attach. */
  | { t: "snapshot"; id: string; data: string }
  | { t: "data"; id: string; data: string }
  | { t: "exit"; id: string; code: number; signal: number | null }
  /** A workspace's list changed: a spawn, an exit or a close. */
  | { t: "changed"; workspace: string };

export interface TerminalViewHandlers {
  /** Replaces whatever the view drew: the screen as the host holds it. */
  onSnapshot: (data: string) => void;
  onData: (data: string) => void;
  onExit: (code: number, signal: number | null) => void;
}

export interface DesktopTerminalApi {
  list: (workspace: string) => Promise<TerminalSession[]>;
  /**
   * Start a shell for `workspace`, in its project folder — with an agent's CLI
   * typed into it for an agent `kind`. The geometry is a first guess; the
   * view's attach sets the real one before anything is drawn.
   *
   * `resume` names one of `agentSessions(workspace)` to continue (FE-23); main
   * refuses an id that listing does not have.
   *
   * `card` starts a NEW agent on a card of this workspace's board (FE-34),
   * its first prompt written by the host; never together with `resume`.
   */
  spawn: (
    workspace: string,
    cols: number,
    rows: number,
    kind?: TerminalKind,
    resume?: string,
    card?: CardBrief,
  ) => Promise<TerminalSession>;
  /**
   * The Claude and Codex conversations kept for `workspace`'s folder, newest
   * first; empty when the project has no folder here.
   */
  agentSessions: (workspace: string) => Promise<AgentSession[]>;
  /**
   * Give a conversation a name in Lanework (FE-24). The CLI's files are never
   * touched; an empty name goes back to the CLI's own title. Answers the new
   * listing. Main refuses an id that `agentSessions(workspace)` does not have.
   */
  renameAgentSession: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
    name: string,
  ) => Promise<AgentSession[]>;
  /** Pin or unpin a conversation (FE-25). Answers the new listing. */
  pinAgentSession: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
    pinned: boolean,
  ) => Promise<AgentSession[]>;
  /**
   * One of a conversation's sub-agents, read for the viewer (FE-35). By ids
   * only: main builds the path inside the CLI's own folder for `workspace`,
   * and refuses an id of any other shape.
   */
  agentSubagent: (
    workspace: string,
    agent: TerminalAgent,
    conversation: string,
    sub: string,
  ) => Promise<SubagentTranscript>;
  /**
   * The tasks Claude conversation `conversation` started in the background,
   * running first then newest first (FE-42). By ids only, as `agentSubagent`.
   */
  agentBackgroundTasks: (
    workspace: string,
    conversation: string,
  ) => Promise<BackgroundTask[]>;
  /**
   * The end of one background shell's output (FE-42/D5). By ids only: main
   * takes the path from the conversation's own transcript, and reads it only
   * inside the CLI's task folder under the temp dir. Poll it while running.
   */
  agentTaskOutput: (
    workspace: string,
    conversation: string,
    task: string,
  ) => Promise<BackgroundTaskOutput>;
  /**
   * Stop one background shell by its conversation and task ids (FE-43).
   * `stopped` counts processes signalled; zero means it was no longer running.
   */
  agentStopTask: (
    workspace: string,
    conversation: string,
    task: string,
  ) => Promise<{ stopped: number }>;
  /**
   * The files conversation `id` edited with its file tools, its sub-agents'
   * folded in (FE-39). By ids only, as `agentSubagent`: main builds every
   * path inside the CLI's own folder for `workspace`.
   */
  agentFiles: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
  ) => Promise<AgentFiles>;
  /**
   * Which of `workspace`'s conversations edited each file since HEAD's
   * commit (FE-39/D2, D3); empty without a repository.
   */
  agentFilesForWorktree: (workspace: string) => Promise<AgentFileMarks>;
  onAgentActivity: (listener: (activity: AgentActivity) => void) => () => void;
  /**
   * The Codex account's usage as its newest turn reported it, and the goals
   * of `workspace`'s listed Codex conversations (FE-41). By workspace only:
   * main picks the files and the threads; a page names neither.
   */
  codexUsage: (workspace: string) => Promise<CodexUsage>;
  /**
   * Fetch Claude account usage now, skipping the cache (FE-53) — the popover's
   * refresh button. Takes nothing: main reads the credential itself and only
   * the safe `ClaudeUsage` comes back, never a token, email or raw body. Null
   * when there is nothing to show at all; a failed fetch answers the last
   * known values with `error` set.
   */
  refreshClaudeUsage: () => Promise<ClaudeUsage | null>;
  /**
   * One conversation's numbers (FE-38). By ids only, as `agentSubagent`:
   * main builds the path inside the CLI's own folder for `workspace`.
   */
  agentFacts: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
  ) => Promise<AgentFacts>;
  /**
   * `workspace`'s agent usage over 7 and 30 days (FE-38/D6); null when the
   * project has no folder here. Reads the end of every recent transcript.
   */
  agentUsage: (workspace: string) => Promise<AgentUsage | null>;
  onAgentWritten: (listener: (write: AgentWrite) => void) => () => void;
  /**
   * The agent CLIs this machine has, asked of the user's own shell: what the
   * + menu offers beside a plain terminal. Cached for a little while.
   */
  agents: () => Promise<TerminalAgent[]>;
  /** Stop a shell and drop its tab. */
  kill: (id: string) => Promise<void>;
  /**
   * Put a workspace's tabs in this order. Kept by the HOST, so every window
   * and every reload lists them the same way; ids it does not know are
   * ignored, and a tab the list leaves out keeps its place at the end.
   */
  reorder: (workspace: string, ids: string[]) => Promise<void>;
  /**
   * Stream one session into a view. The host resizes to `cols`×`rows` FIRST,
   * then sends one snapshot, then live output. Returns the detach.
   */
  attach: (
    id: string,
    cols: number,
    rows: number,
    handlers: TerminalViewHandlers,
  ) => () => void;
  input: (id: string, data: string) => void;
  /**
   * The absolute path of a file dropped on a view. Only the preload can read
   * it (`webUtils`); a dropped `File` no longer carries `.path`.
   */
  pathForFile: (file: File) => string;
  resize: (id: string, cols: number, rows: number) => void;
  /** A workspace's sessions changed; `"*"` when every one may have. */
  onChange: (listener: (workspace: string) => void) => () => void;
  onCommand: (listener: (command: TerminalCommand) => void) => () => void;
}

/** Clamp a geometry value the way the host will. */
export function clampGeometry(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(TERMINAL_LIMITS.maxGeometry, Math.max(1, Math.round(n)));
}
