// A conductor's own sessions: work it hands to a separate conversation the
// user keeps, instead of to a worker of an orchestration run.
//
// A conductor (FE-95) runs `lanework-control sessions.start …` from its
// shell. Main starts a conversation in the project's checkout, on the
// conductor's permission mode, on Claude, Codex or OpenCode (`agent`, by
// default the conductor's own), and names it after the title. The session is
// private to the conductor (FE-128): it carries `launchedBy` and is hidden
// from the Agents rail; the user reaches it through the conductor and sees
// it read-only, unless the conductor lets them work in it (`userAccess` on
// start, or `sessions.access` later). Unless
// told otherwise, main tells the conductor once that session's turn ends, in
// a hidden turn of its own, so it reviews the result and reports back.
// Without user access, the session's permission requests wait on the
// conductor: it is told of each, reads them with `sessions.read` and answers
// with `sessions.answer`.
//
// Unlike `delegate`, nothing here is bound to a run: no write scopes, no
// worktree, no merge. A conductor may only list, read, follow up and answer
// the sessions it started; the user's other conversations are not its to touch.
//
// Memory (FE-128): each conductor keeps one {@link ConductorMemory} per
// project, which outlives its conversations. Main appends to its ledger as
// the conductor's sessions start and stop; the conductor reads it with
// `memory.read`, adds one fact to its free-form notes with `memory.append`
// and replaces them wholesale with `memory.write`.
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
 * conductor's own; `conductors.create` (BE-01, PD-04) and `thread.read`
 * (BE-03) any conversation the app started may call.
 */
export const SESSION_ACTIONS = [
  "sessions.start",
  "sessions.list",
  "sessions.read",
  "sessions.send",
  "sessions.access",
  "sessions.answer",
  "memory.read",
  "memory.append",
  "memory.write",
  "models.list",
  "conductors.create",
  "thread.read",
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
/** Each request's `ask` in `sessions.read`, cut to this. */
export const WAITING_ASK_MAX = 300;
/** Each message `sessions.read` returns, cut to this by default. */
export const READ_CHARS_DEFAULT = 1500;
export const READ_CHARS_MIN = 200;
export const READ_CHARS_MAX = 6000;

/** The most turns one `thread.read` returns (BE-03). */
export const THREAD_READ_LIMIT_MAX = 20;
/** The most text one `thread.read` returns in all, in bytes. */
export const THREAD_READ_BYTES_MAX = 32 * 1024;
/** Each turn's text per `thread.read`; `textOffset` reads on. */
export const THREAD_READ_TURN_CHARS = 4000;
/** A turn reference: `<session>:<index>`. */
export const THREAD_REF_PATTERN = /^[A-Za-z0-9_-]{4,64}:\d{1,6}$/;

/** The most ledger entries a conductor's memory keeps, newest first. */
export const MEMORY_LEDGER_MAX = 30;
/** Each ledger entry's summary, cut to this. */
export const MEMORY_SUMMARY_MAX = 600;
/**
 * A conductor's notes: `memory.write` refuses longer, and so does
 * `memory.append` when the notes would grow past it.
 */
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
    /**
     * Default false: the session is the conductor's and the user sees it
     * read-only. True lets the user send to it, stop it and answer its
     * permissions too.
     */
    userAccess: boolean;
  };
  "sessions.list": Record<string, never>;
  "sessions.read": { sessionId: string; limit: number; maxChars: number };
  "sessions.send": {
    sessionId: string;
    prompt: string;
    notifyOnComplete: boolean;
  };
  /** Let the user work in one of the conductor's sessions, or take it back. */
  "sessions.access": { sessionId: string; userAccess: boolean };
  /**
   * Answer a permission request a session without user access waits on.
   * `message` is the reason told to the session on a deny; absent on allow.
   */
  "sessions.answer": {
    sessionId: string;
    requestId: string;
    allow: boolean;
    message?: string;
  };
  "memory.read": Record<string, never>;
  /**
   * Adds `text` to the notes on a new line; the rest stays. Refused when the
   * notes would grow past {@link MEMORY_NOTES_MAX}.
   */
  "memory.append": { text: string };
  /**
   * Replaces the notes wholesale: what is not sent is gone. An empty string
   * clears them. Never touches the ledger, which main keeps.
   */
  "memory.write": { notes: string };
  /** The catalog a proposal may name, narrowed by agent or id text. */
  "models.list": { agent?: TerminalAgent; query?: string };
  /** Turns of the caller's own thread (BE-03); see {@link ThreadReadInput}. */
  "thread.read": ThreadReadInput;
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
 * - `waiting`: a tool approval or a question waits on the user, or on the
 *   conductor when the user has no access (`sessions.answer`).
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

/** A permission request a session waits on, as `sessions.read` lists it. */
export interface SessionWaiting {
  /** What `sessions.answer` names it by. */
  requestId: string;
  tool: string;
  /**
   * What it asks, on one line, secrets redacted, at most
   * {@link WAITING_ASK_MAX} characters: the first question of a question
   * card, else the request's summary.
   */
  ask: string;
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
 * What `models.list` answers, kept short for an agent's context: ids only,
 * an agent's list as one comma-separated string, OpenCode's per provider
 * with the provider left out of each id.
 */
export interface ModelsListing {
  /** `conductor`: the conductor's own workers; `catalog`: every model. */
  source: "conductor" | "catalog";
  models: Partial<Record<TerminalAgent, string | Record<string, string>>>;
  /** Whether a task may leave agent and model null to be picked by tier. */
  tiers: boolean;
  /**
   * How each model fared in the conductor's past runs: `model` → e.g.
   * `"accepted 5, failed 1"`. Absent when it led none.
   */
  history?: Record<string, string>;
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
    userAccess: boolean;
  };
  "sessions.list": { sessions: SessionSummary[] };
  "sessions.read": {
    sessionId: string;
    title: string;
    status: SessionStatus;
    exchanges: SessionExchange[];
    /** Oldest first; empty when it waits on nothing. */
    waiting: SessionWaiting[];
  };
  "sessions.send": {
    sessionId: string;
    title: string;
    submitted: true;
    notifyOnComplete: boolean;
  };
  /** The session's access as it stands now. */
  "sessions.access": { sessionId: string; title: string; userAccess: boolean };
  /** The request was answered and is no longer waiting. */
  "sessions.answer": {
    sessionId: string;
    title: string;
    requestId: string;
    allow: boolean;
  };
  /** The whole memory: ledger, runs and notes. */
  "memory.read": ConductorMemory;
  /**
   * Not the memory back: only what was kept, so the notes the conductor
   * just sent are not echoed. `memory.read` returns the rest.
   */
  "memory.write": { notesLength: number; updatedAt: number };
  /** As `memory.write`: the notes' new length, not the notes. */
  "memory.append": { notesLength: number; updatedAt: number };
  "models.list": ModelsListing;
  "thread.read": ThreadReadResult;
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

/**
 * `thread.read`'s input: nothing for the sessions, `ref` for one turn,
 * `session` for its turns after `after`.
 */
export interface ThreadReadInput {
  /** One turn, `<session>:<index>`. */
  ref?: string;
  /** With `ref`: where its text reads on from (`nextTextOffset`). */
  textOffset?: number;
  /** A session's reference prefix, or its whole id. */
  session?: string;
  /** With `session`: the turns after this index; absent: from its start. */
  after?: number;
  /** With `session`: at most this many (1-{@link THREAD_READ_LIMIT_MAX}). */
  limit?: number;
  /** Tool calls' outputs too; by default only their name and summary. */
  includeTools?: boolean;
}

/** One turn as `thread.read` returns it. */
export interface ThreadReadTurn {
  ref: string;
  role: "user" | "assistant" | "compaction" | "peer";
  at: string;
  model?: string;
  /** At most {@link THREAD_READ_TURN_CHARS} characters of it. */
  text: string;
  /** Where the rest reads on from; null when this is its end. */
  nextTextOffset: number | null;
}

export interface ThreadReadResult {
  sessions: {
    /** The prefix its references use. */
    session: string;
    conversation: string;
    agent: string;
    model: string | null;
    /** How many turns it has, when the call read it whole. */
    turns?: number;
  }[];
  turns: ThreadReadTurn[];
  /** The next page of `session`'s turns; null when there is none. */
  next: { session: string; after: number } | null;
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

function flag(value: unknown, label: string, fallback = true): boolean {
  if (value === undefined) return fallback;
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
      "userAccess",
    ],
    parse: (input) => {
      const out: SessionInputs["sessions.start"] = {
        title: controlText(input.title, "title", AGENT_NAME_MAX).replace(
          /\s+/g,
          " ",
        ),
        prompt: controlText(input.prompt, "prompt", PROMPT_MAX),
        notifyOnComplete: flag(input.notifyOnComplete, "notifyOnComplete"),
        userAccess: flag(input.userAccess, "userAccess", false),
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
  "sessions.access": {
    fields: ["sessionId", "userAccess"],
    parse: (input) => {
      // NOTE: Required, unlike start's: a call that leaves it out says
      // nothing about which way to turn it.
      if (typeof input.userAccess !== "boolean")
        fail("userAccess must be true or false");
      return {
        sessionId: sessionId(input.sessionId),
        userAccess: input.userAccess,
      };
    },
  },
  "sessions.answer": {
    fields: ["sessionId", "requestId", "allow", "message"],
    parse: (input) => {
      // NOTE: Required: leaving it out must never read as either answer.
      if (typeof input.allow !== "boolean") fail("allow must be true or false");
      const out: SessionInputs["sessions.answer"] = {
        sessionId: sessionId(input.sessionId),
        requestId: controlRequestId(input.requestId),
        allow: input.allow,
      };
      if (input.message !== undefined) {
        if (typeof input.message !== "string") fail("message must be a string");
        if (input.message.length > PROMPT_MAX)
          fail(`message is longer than ${PROMPT_MAX} characters`);
        // NOTE: Taken with allow too, as the contract has it, but dropped:
        // only a deny's answer carries a reason to the session.
        if (!input.allow && input.message.trim())
          out.message = input.message.trim();
      }
      return out;
    },
  },
  "memory.read": { fields: [], parse: () => ({}) },
  "models.list": {
    fields: ["agent", "query"],
    parse: (input) => {
      const out: SessionInputs["models.list"] = {};
      if (input.agent !== undefined)
        out.agent = oneOf(input.agent, TERMINAL_AGENTS, "agent");
      if (input.query !== undefined) {
        if (typeof input.query !== "string" || input.query.length > 120)
          fail("query must be a string of at most 120 characters");
        if (input.query.trim()) out.query = input.query.trim();
      }
      return out;
    },
  },
  "thread.read": {
    fields: ["ref", "textOffset", "session", "after", "limit", "includeTools"],
    parse: (input) => {
      const out: SessionInputs["thread.read"] = {};
      if (input.ref !== undefined) {
        if (
          typeof input.ref !== "string" ||
          !THREAD_REF_PATTERN.test(input.ref)
        )
          fail('ref must be a turn reference such as "1135a96a:42"');
        out.ref = input.ref;
        if (input.textOffset !== undefined)
          out.textOffset = count(
            input.textOffset,
            "textOffset",
            0,
            10_000_000,
            0,
          );
      } else if (input.textOffset !== undefined)
        fail("textOffset goes with ref");
      if (input.session !== undefined) {
        if (out.ref) fail("Give ref or session, not both");
        if (
          typeof input.session !== "string" ||
          !/^[A-Za-z0-9_-]{4,64}$/.test(input.session)
        )
          fail('session must be a session prefix such as "1135a96a"');
        out.session = input.session;
        if (input.after !== undefined)
          out.after = count(input.after, "after", -1, 999_999, -1);
        if (input.limit !== undefined)
          out.limit = count(input.limit, "limit", 1, THREAD_READ_LIMIT_MAX, 10);
      } else if (input.after !== undefined || input.limit !== undefined)
        fail("after and limit go with session");
      if (input.includeTools !== undefined)
        out.includeTools = flag(input.includeTools, "includeTools", false);
      return out;
    },
  },
  "memory.append": {
    fields: ["text"],
    parse: (input) => {
      if (typeof input.text !== "string" || !input.text.trim())
        fail("Provide text as a non-empty string: the one fact to add");
      if (input.text.length > MEMORY_NOTES_MAX)
        fail(
          `text is longer than ${MEMORY_NOTES_MAX} characters: add one short fact`,
        );
      return { text: input.text.trim() };
    },
  },
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
                  "taskId":"FE-98","notifyOnComplete":true,"userAccess":false}
            Conductors only. Start a separate session in this project's
            checkout and submit the prompt as its first turn. It runs on
            your permission mode, under the title, and is yours: the user
            reaches it through you, not the Agents rail, and sees it
            read-only unless "userAccess" is true (they may then send to
            it, stop it and answer its permissions too). "agent"
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
            (${READ_CHARS_MIN}-${READ_CHARS_MAX}), and under "waiting" the
            permission requests it waits on (requestId, tool, ask): answer
            those with sessions.answer.`,
  "sessions.send": `  sessions.send {"sessionId":"...","prompt":"...","notifyOnComplete":true}
            A follow-up to one of your sessions. Refused while it works or
            waits on the user. notifyOnComplete works as in start.`,
  "sessions.access": `  sessions.access {"sessionId":"...","userAccess":true}
            Let the user work in one of your sessions (true), or make it
            read-only to them again (false). Both fields are required. Only
            the conductor that started a session may change it. Returns its
            access as it stands now.`,
  "sessions.answer": `  sessions.answer {"sessionId":"...","requestId":"...","allow":false,
                   "message":"Why it was denied"}
            Answer a permission request one of your sessions waits on (its
            requestId from sessions.read). A session the user has no access
            to waits on you: allow only what its task needs, deny with a
            reason otherwise ("message", at most ${PROMPT_MAX} characters,
            told to the session on a deny only). Refused when the user has access and answers it
            themselves, and for a question: deny it, or give the user access
            so they answer it.`,
  "memory.read": `  memory.read {}
            Conductors only. What you remember of this project across your
            conversations: your last ${MEMORY_LEDGER_MAX} sessions (title, agent,
            model, taskId, status, a summary of at most ${MEMORY_SUMMARY_MAX}
            characters), newest first, the last ${MEMORY_RUNS_MAX} orchestration
            runs you led (title, status, and per worker its agent, model,
            tier and outcome: accepted, cancelled, failed, blocked,
            interrupted or unreviewed), and your notes. Read it before you
            plan.`,
  "memory.append": `  memory.append {"text":"One new decision or fact"}
            Conductors only. Add the text to your notes for this project on
            a new line; the rest stays. Refused when the notes would grow
            past ${MEMORY_NOTES_MAX} characters: then rewrite them shorter
            with memory.write. Prefer it for one new fact.`,
  "models.list": `  models.list {"agent":"claude|codex|opencode","query":"sonnet"}
            The models a proposal's tasks may name, grouped by agent
            (OpenCode's by provider: the id is provider/model). A
            conductor with its own workers gets those only, with their
            tier, and every conductor how each model fared in its runs.
            Both fields are optional.`,
  "thread.read": `  thread.read {"session":"1135a96a","after":-1,"limit":10}
            Any conversation Lanework started. Read the turns of your own
            thread: its earlier sessions (after a switch of agent) and the
            conversation it was handed off from. A handoff block names
            each turn as <session>:<index> and lists the ones it left out.
            {} lists the sessions with their turn counts; {"ref":"1135a96a:42"}
            reads one turn (each cut at ${THREAD_READ_TURN_CHARS} characters:
            pass "textOffset":<nextTextOffset> to read on); {"session":...}
            pages through one session (at most ${THREAD_READ_LIMIT_MAX} turns,
            32 KB a call; follow "next"). Tool calls come as name and
            summary; "includeTools":true adds their outputs. Read a turn
            only when the request needs it.`,
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
export const CREATE_CONDUCTOR_HINT = `Lanework: when the user asks you to create a conductor (a saved team lead in the Lanework app's Conductors rail), call the conductors_create tool (lanework_control), or without it run \`"$${SESSIONS_ENV.cli}" conductors.create --json '{"name":"..."}'\` in the shell; add "instructions", "agent", "model", "effort", "contextFiles", "icon" or "permission" only when the user asked for them. Run it with --help for the fields. It prints one JSON line with the new conductor's id. Never print the LANEWORK_* environment variables.`;

// ─── Stop a conductor (the rail's Stop) ─────────────────────────────────────
//
// Stop on a conductor's row ends every engine it still has in the project:
// its conversations (the current one and any earlier one still running),
// the sessions it started, and the run it leads. A turn in progress is cut
// off; conversations, transcripts, the ledger and memory stay, and the next
// message starts it again.

export const conductorChannels = {
  /** What Stop would end now, without ending anything. */
  stopPreview: "conductors:stop-preview",
  /** End it all; answers with what was ended. */
  stopAll: "conductors:stop-all",
} as const;

/** The run a conductor leads, as Stop ends it. */
export interface ConductorStopRun {
  id: string;
  title: string;
  /** Its workers with a turn running now. */
  workers: number;
}

/** What Stop ended, or would end. */
export interface ConductorStopSummary {
  /** Its conversations with a live engine: the current one, earlier ones. */
  conversations: number;
  /** Sessions it started, with a live engine. */
  sessions: number;
  /** The newest run it leads that is active or paused; null for none. */
  run: ConductorStopRun | null;
}

/** {@link ConductorStopSummary} before Stop, with what the dialog says. */
export interface ConductorStopPreview extends ConductorStopSummary {
  /** One of its conversations is in the middle of a turn. */
  answering: boolean;
}

/** Whether Stop has anything to end. */
export function hasConductorStop(summary: ConductorStopSummary): boolean {
  return (
    summary.conversations > 0 || summary.sessions > 0 || summary.run !== null
  );
}

/** Stop for a conductor in the renderer. `lead` is a lead ref. */
export interface DesktopConductorsApi {
  stopPreview: (project: string, lead: string) => Promise<ConductorStopPreview>;
  stopAll: (project: string, lead: string) => Promise<ConductorStopSummary>;
}
