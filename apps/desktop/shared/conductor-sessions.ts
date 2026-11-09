// A conductor's own sessions: work it hands to a separate conversation the
// user keeps, instead of to a worker of an orchestration run.
//
// A conductor (FE-95) runs `lanework-control sessions.start …` from its
// shell. Main starts a conversation in the project's checkout, on the
// conductor's permission mode, on Claude, Codex or OpenCode (`agent`, by
// default the conductor's own), and names it after the title. The session is
// private to the conductor (FE-128): it carries `launchedBy` and is hidden
// from the Agents rail; the user reaches it through the conductor. Unless
// told otherwise, main tells the conductor once that session's turn ends, in
// a hidden turn of its own, so it reviews the result and reports back.
//
// Unlike `delegate`, nothing here is bound to a run: no write scopes, no
// worktree, no merge. A conductor may only list, read and follow up the
// sessions it started; the user's other conversations are not its to touch.
//
// Memory (FE-128): each conductor keeps one {@link ConductorMemory} per
// project, which outlives its conversations. Main appends to its ledger as
// the conductor's sessions start and stop; the conductor reads it with
// `memory.read` and replaces its free-form notes with `memory.write`.
//
// NOTE: Shapes, limits and validators only. Imported by the CLI bundle and
// the renderer, so no Node or Electron.

import {
  EFFORTS,
  type Effort,
  OPENCODE_MODEL_ID,
  PERMISSIONS,
  type Permission,
} from "./conversation";
import {
  ControlInputError,
  contextPath,
  controlEffort,
  controlObject,
  controlRequestId,
  controlText,
  LEAD_AGENTS,
  LEAD_CONTEXT_FILES_MAX,
  LEAD_ICONS,
  LEAD_INSTRUCTIONS_MAX,
  LEAD_NAME_MAX,
  type LeadAgent,
  type LeadIcon,
  MODEL_ID_PATTERN,
  PROMPT_MAX,
  TIERS,
  type Tier,
} from "./orchestration";
import {
  AGENT_NAME_MAX,
  isAgentSessionId,
  isAgentSessionIdOf,
  isTerminalAgent,
  TERMINAL_AGENTS,
  type TerminalAgent,
} from "./terminal";

/**
 * Every action a conversation's sessions token carries, in the order
 * `--help` lists them. `sessions.*` and `memory.*` (FE-128) are a
 * conductor's own; `conductors.create` (BE-01, PD-04) any conversation the
 * app started may call.
 */
export const SESSION_ACTIONS = [
  "sessions.start",
  "sessions.list",
  "sessions.read",
  "sessions.send",
  "memory.read",
  "memory.write",
  "conductors.create",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export function isSessionAction(value: unknown): value is SessionAction {
  return (
    typeof value === "string" &&
    (SESSION_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The env main gives every chat engine's process besides a worker's. The
 * endpoint is `CONTROL_ENV.endpoint`; whether the process may start sessions
 * is checked on each call: only a conductor's own conversation may.
 */
export const SESSIONS_ENV = {
  token: "LANEWORK_SESSIONS_TOKEN",
  /** The control CLI's path, so the conductor's rules can name it. */
  cli: "LANEWORK_CONTROL_CLI",
} as const;

/** The hidden block main sends a conductor when its sessions stopped. */
export const SESSIONS_TAG = "lanework_sessions";

/** The most sessions one conductor may have working at once. */
export const SESSIONS_RUNNING_MAX = 4;
/** The most sessions `sessions.list` returns, newest first. */
export const SESSIONS_LIST_MAX = 20;
/** The most exchanges one `sessions.read` returns. */
export const READ_LIMIT_MAX = 5;
/** Each message `sessions.read` returns, cut to this by default. */
export const READ_CHARS_DEFAULT = 1500;
export const READ_CHARS_MIN = 200;
export const READ_CHARS_MAX = 6000;

/** The most ledger entries a conductor's memory keeps, newest first. */
export const MEMORY_LEDGER_MAX = 30;
/** Each ledger entry's summary, cut to this. */
export const MEMORY_SUMMARY_MAX = 600;
/** A conductor's notes: `memory.write` refuses longer. */
export const MEMORY_NOTES_MAX = 8000;
/** The most orchestration runs a conductor's memory keeps, newest first. */
export const MEMORY_RUNS_MAX = 20;
/** The most tasks one remembered run keeps. */
export const MEMORY_RUN_TASKS_MAX = 24;
/** A remembered task's error, cut to this. */
export const MEMORY_RUN_ERROR_MAX = 200;

/** A board task id, as the checkpoint hook reads one: `FE-98`. */
const TASK_ID = /^[A-Z]{2,5}-\d{1,5}$/;

/** What each action takes. */
export interface SessionInputs {
  "sessions.start": {
    title: string;
    prompt: string;
    /** The CLI it runs on. Absent: the conductor's own (Claude or Codex). */
    agent?: TerminalAgent;
    /**
     * Absent: the conductor's own model when it runs on the conductor's
     * agent, else that agent's default. With `agent: "opencode"` it is
     * `provider/model`.
     */
    model?: string;
    /** Absent: the conductor's own effort. */
    effort?: Effort;
    /** The board card it works on: the prompt names it first. */
    taskId?: string;
    /** Default true: tell the conductor when its turn ends. */
    notifyOnComplete: boolean;
  };
  "sessions.list": Record<string, never>;
  "sessions.read": { sessionId: string; limit: number; maxChars: number };
  "sessions.send": {
    sessionId: string;
    prompt: string;
    notifyOnComplete: boolean;
  };
  "memory.read": Record<string, never>;
  /**
   * Replaces the notes wholesale: what is not sent is gone. An empty string
   * clears them. Never touches the ledger, which main keeps.
   */
  "memory.write": { notes: string };
  /**
   * A personal conductor of the caller's project. Every field left out takes
   * the default the rail's dialog gives, or the caller's own agent and model.
   */
  "conductors.create": {
    name: string;
    /** Absent: the template the rail's dialog starts with. */
    instructions?: string;
    icon?: LeadIcon;
    /** Absent: the caller's agent, or Claude for an OpenCode caller. */
    agent?: LeadAgent;
    /** Absent: the caller's model when it runs on `agent`. */
    model?: string;
    effort?: Effort;
    contextFiles?: string[];
    permission?: Permission;
  };
}

export type SessionCall = {
  [A in SessionAction]: { action: A; input: SessionInputs[A] };
}[SessionAction];

/**
 * Where a session stands.
 *
 * - `waiting`: a tool approval or a question waits on the user.
 * - `terminal`: a terminal runs it; Lanework cannot send to it.
 */
export type SessionStatus =
  | "working"
  | "waiting"
  | "idle"
  | "failed"
  | "terminal";

export interface SessionSummary {
  sessionId: string;
  title: string;
  agent: TerminalAgent;
  model: string;
  status: SessionStatus;
  /** The conductor hears when its current turn ends. */
  notifyOnComplete: boolean;
  createdAt: number;
}

/** One prompt and the answer to it, each cut to `maxChars`. */
export interface SessionExchange {
  prompt: string;
  reply: string;
}

const SESSION_STATUSES: readonly SessionStatus[] = [
  "working",
  "waiting",
  "idle",
  "failed",
  "terminal",
];

/** One session a conductor started, as its memory remembers it. */
export interface ConductorLedgerEntry {
  sessionId: string;
  title: string;
  agent: TerminalAgent;
  model: string;
  /** The board card it works on, when `sessions.start` named one. */
  taskId?: string;
  status: SessionStatus;
  /**
   * What came of it, at most {@link MEMORY_SUMMARY_MAX} characters: its
   * last reply, cut.
   */
  summary: string;
  /** When main last wrote this entry, epoch ms. */
  updatedAt: number;
}

/** How a worker of an orchestration run ended, as a conductor remembers it. */
export const RUN_TASK_OUTCOMES = [
  "accepted",
  "cancelled",
  "failed",
  "blocked",
  "interrupted",
  "unreviewed",
] as const;
export type RunTaskOutcome = (typeof RUN_TASK_OUTCOMES)[number];

/** How a remembered run ended. */
export const RUN_END_STATUSES = ["finished", "stopped"] as const;
export type RunEndStatus = (typeof RUN_END_STATUSES)[number];

/** One worker of a remembered run. */
export interface ConductorRunTask {
  title: string;
  agent: TerminalAgent;
  model: string;
  /** The tier it ran on; null when the lead named the model itself. */
  tier: Tier | null;
  effort: Effort | null;
  outcome: RunTaskOutcome;
  /** What went wrong, cut to {@link MEMORY_RUN_ERROR_MAX}; absent when nothing. */
  error?: string;
}

/**
 * One orchestration run the conductor led, as its memory remembers it
 * (FE-131): written once, when the run finished or was stopped.
 */
export interface ConductorRunEntry {
  runId: string;
  title: string;
  status: RunEndStatus;
  createdAt: number;
  endedAt: number;
  tasks: ConductorRunTask[];
}

/**
 * What a conductor remembers of one project, across its conversations
 * (FE-128). One per conductor × project; main keeps the ledger and the
 * runs, the conductor its notes.
 */
export interface ConductorMemory {
  /**
   * Its sessions, newest first, at most {@link MEMORY_LEDGER_MAX}: the
   * oldest falls off. One entry per session, updated in place.
   */
  ledger: ConductorLedgerEntry[];
  /**
   * The runs it led, newest first, at most {@link MEMORY_RUNS_MAX}: the
   * oldest falls off. One entry per run. Absent in a memory written before
   * FE-131; reads as `[]`.
   */
  runs: ConductorRunEntry[];
  /** Its own notes, at most {@link MEMORY_NOTES_MAX} characters. */
  notes: string;
  /** When either part last changed, epoch ms; 0 for a memory never written. */
  updatedAt: number;
}

/** A memory nothing was written to yet. */
export function emptyConductorMemory(): ConductorMemory {
  return { ledger: [], runs: [], notes: "", updatedAt: 0 };
}

/** What each action answers with, under `result`. */
export interface SessionResults {
  "sessions.start": {
    sessionId: string;
    title: string;
    agent: TerminalAgent;
    model: string;
    notifyOnComplete: boolean;
  };
  "sessions.list": { sessions: SessionSummary[] };
  "sessions.read": {
    sessionId: string;
    title: string;
    status: SessionStatus;
    exchanges: SessionExchange[];
  };
  "sessions.send": {
    sessionId: string;
    title: string;
    submitted: true;
    notifyOnComplete: boolean;
  };
  /** The whole memory: ledger, runs and notes. */
  "memory.read": ConductorMemory;
  /**
   * Not the memory back: only what was kept, so the notes the conductor
   * just sent are not echoed. `memory.read` returns the rest.
   */
  "memory.write": { notesLength: number; updatedAt: number };
  "conductors.create": {
    /** Its id, picked by the app: never one already taken. */
    id: string;
    name: string;
    icon: LeadIcon;
    agent: LeadAgent;
    model: string;
    effort: Effort | null;
    contextFiles: string[];
    permission: Permission | null;
  };
}

function fail(message: string): never {
  throw new ControlInputError(message);
}

/**
 * A session id any of the three CLIs writes: a UUID, or OpenCode's `ses_…`
 * (FE-128: a conductor may start OpenCode sessions).
 */
function isSessionIdOfAny(value: unknown): value is string {
  return isAgentSessionId(value) || isAgentSessionIdOf("opencode", value);
}

function sessionId(value: unknown): string {
  if (!isSessionIdOfAny(value))
    fail("sessionId must be a session id from sessions.list");
  return value;
}

function flag(value: unknown, label: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") fail(`${label} must be true or false`);
  return value;
}

function count(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    fail(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    fail(`${label} must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** A model id of `agent`'s shape, or of a plain CLI's when it is absent. */
function sessionModel(
  value: unknown,
  agent: TerminalAgent | undefined,
): string {
  const opencode = agent === "opencode";
  if (
    typeof value !== "string" ||
    !(opencode ? OPENCODE_MODEL_ID : MODEL_ID_PATTERN).test(value)
  )
    fail(
      opencode
        ? "model must be an OpenCode model id (provider/model); leave it out for OpenCode's default"
        : "model must be a model id; leave it out for the conductor's",
    );
  return value;
}

type Parsers = {
  [A in SessionAction]: (input: Record<string, unknown>) => SessionInputs[A];
};

const SCHEMAS: {
  [A in SessionAction]: { fields: readonly string[]; parse: Parsers[A] };
} = {
  "sessions.start": {
    fields: [
      "title",
      "prompt",
      "agent",
      "model",
      "effort",
      "taskId",
      "notifyOnComplete",
    ],
    parse: (input) => {
      const out: SessionInputs["sessions.start"] = {
        title: controlText(input.title, "title", AGENT_NAME_MAX).replace(
          /\s+/g,
          " ",
        ),
        prompt: controlText(input.prompt, "prompt", PROMPT_MAX),
        notifyOnComplete: flag(input.notifyOnComplete, "notifyOnComplete"),
      };
      if (input.agent !== undefined)
        out.agent = oneOf(input.agent, TERMINAL_AGENTS, "agent");
      if (input.model !== undefined)
        out.model = sessionModel(input.model, out.agent);
      if (input.effort !== undefined)
        out.effort = controlEffort(input.effort, "effort");
      if (input.taskId !== undefined) {
        if (typeof input.taskId !== "string" || !TASK_ID.test(input.taskId))
          fail('taskId must be a board task id such as "FE-98"');
        out.taskId = input.taskId;
      }
      return out;
    },
  },
  "sessions.list": { fields: [], parse: () => ({}) },
  "sessions.read": {
    fields: ["sessionId", "limit", "maxChars"],
    parse: (input) => ({
      sessionId: sessionId(input.sessionId),
      limit: count(input.limit, "limit", 1, READ_LIMIT_MAX, 2),
      maxChars: count(
        input.maxChars,
        "maxChars",
        READ_CHARS_MIN,
        READ_CHARS_MAX,
        READ_CHARS_DEFAULT,
      ),
    }),
  },
  "sessions.send": {
    fields: ["sessionId", "prompt", "notifyOnComplete"],
    parse: (input) => ({
      sessionId: sessionId(input.sessionId),
      prompt: controlText(input.prompt, "prompt", PROMPT_MAX),
      notifyOnComplete: flag(input.notifyOnComplete, "notifyOnComplete"),
    }),
  },
  "memory.read": { fields: [], parse: () => ({}) },
  "memory.write": {
    fields: ["notes"],
    parse: (input) => {
      if (typeof input.notes !== "string")
        fail('Provide notes as a string; "" clears them');
      if (input.notes.length > MEMORY_NOTES_MAX)
        fail(
          `notes is longer than ${MEMORY_NOTES_MAX} characters: keep what matters, they replace the old ones`,
        );
      return { notes: input.notes.trim() };
    },
  },
  "conductors.create": {
    fields: [
      "name",
      "instructions",
      "icon",
      "agent",
      "model",
      "effort",
      "contextFiles",
      "permission",
    ],
    parse: (input) => {
      const name = controlText(input.name, "name", LEAD_NAME_MAX);
      if (/[\r\n]/.test(name)) fail("name must be one line");
      const out: SessionInputs["conductors.create"] = { name };
      if (input.instructions !== undefined) {
        if (
          typeof input.instructions !== "string" ||
          input.instructions.length > LEAD_INSTRUCTIONS_MAX
        )
          fail(
            `instructions must be a string of at most ${LEAD_INSTRUCTIONS_MAX} characters`,
          );
        out.instructions = input.instructions;
      }
      if (input.icon !== undefined)
        out.icon = oneOf(input.icon, LEAD_ICONS, "icon");
      if (input.agent !== undefined)
        out.agent = oneOf(input.agent, LEAD_AGENTS, "agent");
      if (input.model !== undefined) {
        if (
          typeof input.model !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.model)
        )
          fail("model must be a model id; leave it out for yours");
        out.model = input.model;
      }
      if (input.effort !== undefined)
        out.effort = controlEffort(input.effort, "effort");
      if (input.contextFiles !== undefined) {
        if (
          !Array.isArray(input.contextFiles) ||
          input.contextFiles.length > LEAD_CONTEXT_FILES_MAX
        )
          fail(
            `contextFiles must list at most ${LEAD_CONTEXT_FILES_MAX} paths`,
          );
        out.contextFiles = [
          ...new Set(
            input.contextFiles.map((entry, index) =>
              contextPath(entry, `Context file ${index + 1}`),
            ),
          ),
        ];
      }
      if (input.permission !== undefined)
        out.permission = oneOf(input.permission, PERMISSIONS, "permission");
      return out;
    },
  },
};

function ledgerEntry(value: unknown): ConductorLedgerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    !isTerminalAgent(entry.agent) ||
    !isAgentSessionIdOf(entry.agent, entry.sessionId) ||
    typeof entry.title !== "string" ||
    typeof entry.model !== "string" ||
    !SESSION_STATUSES.includes(entry.status as SessionStatus) ||
    typeof entry.summary !== "string" ||
    typeof entry.updatedAt !== "number" ||
    !Number.isFinite(entry.updatedAt)
  )
    return null;
  const out: ConductorLedgerEntry = {
    sessionId: entry.sessionId,
    title: entry.title.slice(0, AGENT_NAME_MAX),
    agent: entry.agent,
    model: entry.model,
    status: entry.status as SessionStatus,
    summary: entry.summary.slice(0, MEMORY_SUMMARY_MAX),
    updatedAt: entry.updatedAt,
  };
  if (typeof entry.taskId === "string" && TASK_ID.test(entry.taskId))
    out.taskId = entry.taskId;
  return out;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function runTask(value: unknown): ConductorRunTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (
    typeof task.title !== "string" ||
    !isTerminalAgent(task.agent) ||
    typeof task.model !== "string" ||
    !RUN_TASK_OUTCOMES.includes(task.outcome as RunTaskOutcome)
  )
    return null;
  const out: ConductorRunTask = {
    title: task.title.slice(0, AGENT_NAME_MAX),
    agent: task.agent,
    model: task.model,
    tier: TIERS.includes(task.tier as Tier) ? (task.tier as Tier) : null,
    effort: EFFORTS.includes(task.effort as Effort)
      ? (task.effort as Effort)
      : null,
    outcome: task.outcome as RunTaskOutcome,
  };
  if (typeof task.error === "string" && task.error)
    out.error = task.error.slice(0, MEMORY_RUN_ERROR_MAX);
  return out;
}

function runEntry(value: unknown): ConductorRunEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.runId !== "string" ||
    !entry.runId ||
    typeof entry.title !== "string" ||
    !RUN_END_STATUSES.includes(entry.status as RunEndStatus) ||
    !isFiniteNumber(entry.createdAt) ||
    !isFiniteNumber(entry.endedAt) ||
    !Array.isArray(entry.tasks)
  )
    return null;
  return {
    runId: entry.runId,
    title: entry.title.slice(0, AGENT_NAME_MAX),
    status: entry.status as RunEndStatus,
    createdAt: entry.createdAt,
    endedAt: entry.endedAt,
    tasks: entry.tasks
      .map(runTask)
      .filter((task): task is ConductorRunTask => task !== null)
      .slice(0, MEMORY_RUN_TASKS_MAX),
  };
}

/**
 * A memory as read back from disk, made safe to use: entries of a bad shape
 * and repeats of a session dropped, the ledger sorted newest first and cut
 * to {@link MEMORY_LEDGER_MAX}, summaries and notes cut to their limits. Runs
 * get the same: a bad entry or a repeat of a run is dropped, the rest sorted
 * newest first and cut to {@link MEMORY_RUNS_MAX}; a memory without runs
 * reads with none.
 * Anything that is not a memory reads as an empty one.
 */
export function normalizeConductorMemory(value: unknown): ConductorMemory {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyConductorMemory();
  const memory = value as Record<string, unknown>;
  const ledger = (Array.isArray(memory.ledger) ? memory.ledger : [])
    .map(ledgerEntry)
    .filter((entry): entry is ConductorLedgerEntry => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const seenRuns = new Set<string>();
  const runs = (Array.isArray(memory.runs) ? memory.runs : [])
    .map(runEntry)
    .filter((entry): entry is ConductorRunEntry => entry !== null)
    .sort((a, b) => b.endedAt - a.endedAt)
    .filter((entry) => {
      if (seenRuns.has(entry.runId)) return false;
      seenRuns.add(entry.runId);
      return true;
    })
    .slice(0, MEMORY_RUNS_MAX);
  const seen = new Set<string>();
  return {
    runs,
    ledger: ledger
      .filter((entry) => {
        if (seen.has(entry.sessionId)) return false;
        seen.add(entry.sessionId);
        return true;
      })
      .slice(0, MEMORY_LEDGER_MAX),
    notes:
      typeof memory.notes === "string"
        ? memory.notes.slice(0, MEMORY_NOTES_MAX)
        : "",
    updatedAt:
      typeof memory.updatedAt === "number" && Number.isFinite(memory.updatedAt)
        ? memory.updatedAt
        : 0,
  };
}

/** The fields each action takes, for `--help` and error messages. */
export function sessionFields(action: SessionAction): readonly string[] {
  return SCHEMAS[action].fields;
}

/**
 * Check one `sessions.*` call's input: only its fields, each of its shape.
 *
 * @throws {ControlInputError} On an unknown action or field, or a bad value.
 */
export function parseSessionInput(
  action: unknown,
  input: unknown,
): SessionCall {
  if (!isSessionAction(action))
    fail(
      `Unknown action ${JSON.stringify(action)}. Use one of: ${SESSION_ACTIONS.join(", ")}`,
    );
  const schema = SCHEMAS[action] as {
    fields: readonly string[];
    parse: (input: Record<string, unknown>) => unknown;
  };
  const checked = controlObject(
    input ?? {},
    schema.fields,
    `${action}'s input`,
  );
  return { action, input: schema.parse(checked) } as SessionCall;
}

/**
 * Check one line from the CLI for a `sessions.*` action.
 *
 * @throws {ControlInputError} On anything {@link parseSessionInput} refuses,
 *   or an envelope with a missing or unknown field.
 */
export function parseSessionRequest(
  value: unknown,
): SessionCall & { token: string; requestId: string } {
  const envelope = controlObject(
    value,
    ["token", "action", "input", "requestId"],
    "The request",
  );
  if (typeof envelope.token !== "string" || !envelope.token)
    fail("The request carries no token");
  return {
    ...parseSessionInput(envelope.action, envelope.input),
    token: envelope.token,
    requestId: controlRequestId(envelope.requestId),
  };
}

/** `--help`'s lines for the `sessions.*` actions. */
export const SESSION_HELP: Record<SessionAction, string> = {
  "sessions.start": `  sessions.start {"title":"Short title","prompt":"Self-contained instructions",
                  "agent":"${TERMINAL_AGENTS.join("|")}",
                  "model":"<model id>","effort":"${EFFORTS.join("|")}",
                  "taskId":"FE-98","notifyOnComplete":true}
            Conductors only. Start a separate session in this project's
            checkout and submit the prompt as its first turn. It runs on
            your permission mode, under the title, and is yours alone: the
            user reaches it through you, not the Agents rail. "agent"
            defaults to yours; "model" and "effort" to yours on your agent,
            else that agent's default (OpenCode's model is provider/model).
            "taskId" names the board card it works on. Unless
            notifyOnComplete is false, Lanework tells you once its turn
            ends: review it then and report to the user. Returns as soon as
            the session started, with its sessionId. At most
            ${SESSIONS_RUNNING_MAX} of your sessions may work at once.`,
  "sessions.list": `  sessions.list {}
            The sessions you started, newest first, with their status:
            working, waiting (on the user), idle, failed or terminal.`,
  "sessions.read": `  sessions.read {"sessionId":"...","limit":2,"maxChars":${READ_CHARS_DEFAULT}}
            The last exchanges of one of your sessions (1-${READ_LIMIT_MAX}),
            prompts and replies only, each cut to maxChars
            (${READ_CHARS_MIN}-${READ_CHARS_MAX}).`,
  "sessions.send": `  sessions.send {"sessionId":"...","prompt":"...","notifyOnComplete":true}
            A follow-up to one of your sessions. Refused while it works or
            waits on the user. notifyOnComplete works as in start.`,
  "memory.read": `  memory.read {}
            Conductors only. What you remember of this project across your
            conversations: your last ${MEMORY_LEDGER_MAX} sessions (title, agent,
            model, taskId, status, a summary of at most ${MEMORY_SUMMARY_MAX}
            characters), newest first, the last ${MEMORY_RUNS_MAX} orchestration
            runs you led (title, status, and per worker its agent, model,
            tier and outcome: accepted, cancelled, failed, blocked,
            interrupted or unreviewed), and your notes. Read it before you
            plan.`,
  "memory.write": `  memory.write {"notes":"Decisions, open threads, what to check next"}
            Conductors only. Replace your notes for this project, at most
            ${MEMORY_NOTES_MAX} characters: send everything worth keeping, the
            old notes are gone. "" clears them. Lanework keeps the ledger.`,
  "conductors.create": `  conductors.create {"name":"Release captain","instructions":"## Role\\n...",
                  "icon":"Robot02Icon","agent":"${LEAD_AGENTS.join('"|"')}",
                  "model":"<model id>","effort":"${EFFORTS.join("|")}",
                  "contextFiles":["docs/release.md"],
                  "permission":"${PERMISSIONS.join("|")}"}
            Any conversation Lanework started. Save a conductor of your own
            in this project, as the Conductors rail's dialog would, and
            return its id. Only "name" is required: "agent", "model" and
            "effort" default to yours, "instructions" to the dialog's
            template, "contextFiles" (project-relative) to none,
            "permission" to the composer's default. Never replaces one: a
            taken id gets -2, -3... It does not start the conductor or make
            it the default; the user opens it from the rail.
            icon: ${LEAD_ICONS.join(", ")}.`,
};

/**
 * What a conversation the app started is told about `conductors.create`,
 * once, when its process starts (BE-01). Fixed text, so a conversation's
 * prompt prefix never changes between its turns.
 */
export const CREATE_CONDUCTOR_HINT = `Lanework: when the user asks you to create a conductor (a saved team lead in the Lanework app's Conductors rail), run \`"$${SESSIONS_ENV.cli}" conductors.create --json '{"name":"..."}'\` in the shell; add "instructions", "agent", "model", "effort", "contextFiles", "icon" or "permission" only when the user asked for them. Run it with --help for the fields. It prints one JSON line with the new conductor's id. Never print the LANEWORK_* environment variables.`;
