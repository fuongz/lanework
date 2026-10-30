// The orchestration contract (FE-87): a lead conversation (Claude or Codex)
// spawns worker conversations (Claude, Codex or OpenCode, FE-105) on demand, and Jev, a cheap calibrated judge,
// answers the bounded questions on the way so the lead is asked only when
// Jev is unsure.
//
// Three surfaces share these types:
//
// - The CONTROL server in main, which the lead's CLI reaches over loopback
//   with a per-run token. It takes the twelve actions below, each a JSON
//   object checked by {@link parseControlInput}. A field this file does not
//   name is refused, never ignored: a typo in `dependsOn` must not queue a
//   worker with no dependencies.
// - The renderer, through `desktop.orchestration` and `desktop.jev`. As with
//   the conversation view, it names a project and ids, never a folder or a
//   command.
// - Main's own modules (the run engine and Jev), whose handler shapes are
//   fixed here so `main/index.ts` can register them before they exist.
//
// NOTE: No runtime logic lives here, only shapes, limits and validators. The
// file is imported by the preload and the renderer, so it must not import
// Node or Electron.
//
// NOTE: OpenCode may be a worker, never the lead (FE-105/D5). A lead's CLI
// must start with the run's control env, and OpenCode runs inside the user's
// own service, which no env of ours reaches. Every validator that reads a
// lead's agent ({@link LEAD_AGENTS}) refuses it; the ones that read a
// worker's ({@link WORKER_AGENTS}) take it, with a `provider/model` id.

import {
  type ConversationAgent,
  EFFORTS,
  type Effort,
  OPENCODE_MODEL_ID,
  PERMISSIONS,
  type Permission,
} from "./conversation";

// ─── Limits ─────────────────────────────────────────────────────────────────

/** The most one control request's input may weigh, as JSON text. */
export const CONTROL_INPUT_MAX = 256 * 1024;
/** The most one control response may weigh, as JSON text. */
export const CONTROL_RESPONSE_MAX = 2_000_000;
/** The longest `wait` may block, in seconds. */
export const WAIT_MAX_SECONDS = 25;
/** The most workers one run may hold. */
export const TASKS_MAX = 40;
/** The most workers that may run at once. */
export const WORKERS_MAX = 4;
/** The most write scopes one task may claim. */
export const FILES_MAX = 64;
/** The longest a waiting tool's input may be in `needsInput`. */
export const NEEDS_INPUT_MAX = 4_000;
/** The longest a title may be. */
export const TITLE_MAX = 160;
/** The longest a worker's instructions, or a steer/message, may be. */
export const PROMPT_MAX = 30_000;
/** The longest a request id may be. */
export const REQUEST_ID_MAX = 128;

/** What a task, run or request id may be. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** What a request id may be: a UUID, or a worker CLI's own request id. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * What a Claude or Codex model id may be: it becomes `--model` / `-m`'s
 * value. An OpenCode worker's is `provider/model` instead
 * (`OPENCODE_MODEL_ID`, FE-105).
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The CLIs a run's lead (or a team lead's own model) may run on (FE-105/D5). */
export const LEAD_AGENTS = ["claude", "codex"] as const;
export type LeadAgent = (typeof LEAD_AGENTS)[number];
/** The CLIs a worker may run on: a lead's, and OpenCode (FE-105/D5). */
export const WORKER_AGENTS = ["claude", "codex", "opencode"] as const;

/** Whether `agent` may lead a run: OpenCode may only be a worker. */
export function canLead(agent: ConversationAgent | null): agent is LeadAgent {
  return (LEAD_AGENTS as readonly string[]).includes(agent ?? "");
}

// ─── Run and task ───────────────────────────────────────────────────────────

/**
 * Where a worker stands.
 *
 * - `cancelling`: asked to stop, not yet stopped.
 * - `blocked`: stopped on a policy (a write outside its scope); it waits for
 *   `message`, `retry` or `cancel`.
 * - `interrupted`: the app quit or the run paused under it; Resume continues
 *   it in its kept worktree.
 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A task in one of these will not change again by itself. */
export const SETTLED_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "blocked",
  "interrupted",
  "cancelled",
];

export const RUN_STATUSES = [
  "active",
  "paused",
  "stopped",
  "finished",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Jev's three tiers, cheapest first. */
export const TIERS = ["light", "standard", "heavy"] as const;
export type Tier = (typeof TIERS)[number];

/** A model a worker may run on: the CLI, the model id, and its label. */
export interface WorkerChoice {
  agent: ConversationAgent;
  model: string;
  label: string;
}

/**
 * What a worker waits on: a tool approval, or `AskUserQuestion`.
 *
 * Workers never prompt the user. The lead answers with `respond` or `answer`.
 */
export type NeedsInput =
  | {
      kind: "permission";
      /** The control request's id, as the worker's CLI gave it. */
      requestId: string;
      tool: string;
      summary: string;
      /**
       * The tool's input as the worker sent it (the command, the path, the
       * URL), secrets redacted and cut at {@link NEEDS_INPUT_MAX}, so the
       * lead and Jev decide on what would run, not on a description (D13).
       * Absent on a request recorded before it was kept.
       */
      input?: string;
    }
  | {
      kind: "question";
      requestId: string;
      questions: {
        question: string;
        header: string;
        options: { label: string; description: string }[];
        multiSelect: boolean;
      }[];
    };

export interface OrchestrationTask {
  id: string;
  title: string;
  agent: ConversationAgent;
  model: string;
  effort: Effort | null;
  /** The tier it runs on; null when the lead named the model itself. */
  tier: Tier | null;
  /** Self-contained instructions, as the lead wrote them. */
  prompt: string;
  /**
   * Write scopes, project-relative. A directory covers what is under it;
   * `["."]` claims the whole checkout.
   */
  files: string[];
  /** Task ids that must be accepted before this one starts. */
  dependsOn: string[];
  status: TaskStatus;
  /** The lead reviewed and took its result (`review`). */
  accepted: boolean;
  /** The worker's last answer; empty until it has one. */
  result: string;
  error: string | null;
  needsInput: NeedsInput | null;
  /**
   * Write scopes the lead asked for (`delegate`, `retry`) beyond what the
   * user approved, or naming an agent config path: the task stays queued
   * until the user approves them on the run's panel, or cancels it (D11).
   * Null or absent: nothing waits on the user.
   */
  scopeApproval?: string[] | null;
  /** The worker's conversation id, once it has started. */
  conversation: string | null;
  /** The worker's branch in its own worktree, once it has one. */
  branch: string | null;
  /**
   * Why a queued task has not started, as main worked it out when it sent
   * the task (FE-100/O5): a dependency, files another task holds (in this
   * run or another open run of the project), a worker slot, the user.
   * Absent when it is not queued, or may start now.
   */
  waitingFor?: string;
  /**
   * The dependency it waits on was cancelled, by id: it never starts by
   * itself, so the page shows it as blocked (FE-100/O5).
   */
  cancelledDependency?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationRun {
  id: string;
  /** The project slug the run belongs to. */
  project: string;
  /** The lead's conversation id. */
  lead: string;
  leadAgent: ConversationAgent;
  status: RunStatus;
  /** Why it paused or stopped, with what to do next. */
  reason: string | null;
  maxWorkers: number;
  /** The models `delegate` may name. */
  choices: WorkerChoice[];
  /** Whether Jev's `model-tier` point is asked when `delegate` names no model. */
  jev: boolean;
  /**
   * The {@link TeamLead} preset the run was approved with, by id; null when
   * it ran without one (FE-88). Not to be confused with `lead`, the lead's
   * conversation.
   */
  teamLead: string | null;
  tasks: OrchestrationTask[];
  /**
   * When the user removed what a stopped run left behind: its worktrees,
   * branches and refs (FE-100/O2). Absent until then.
   */
  cleanedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a stopped run left in the project's git (FE-100/O2): the worktrees
 * kept with unreviewed work, their `lanework/<run>/<task>` branches, and the
 * app's own refs under `refs/lanework/baseline/` and `refs/lanework/saved/`.
 */
export interface RunLeftovers {
  worktrees: {
    path: string;
    /** The task it was made for; null for one no task names any more. */
    taskId: string | null;
    title: string | null;
  }[];
  branches: string[];
  refs: string[];
}

// ─── Proposal ───────────────────────────────────────────────────────────────

/** One worker the lead proposes, before the user approves the run. */
export interface ProposedTask {
  id: string;
  title: string;
  prompt: string;
  /** Null: the tier's (see {@link DelegateInput.model}). */
  agent: ConversationAgent | null;
  /** Null: the tier's (see {@link DelegateInput.model}). */
  model: string | null;
  effort: Effort | null;
  files: string[];
  dependsOn: string[];
}

export const PROPOSAL_STATUSES = [
  "planning",
  "ready",
  "invalid",
  "starting",
  "approved",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * The lead's plan, shown as a card the user edits and approves.
 *
 * NOTE: Nothing runs until it is approved. A reload turns `planning` into
 * `invalid` and `starting` back into `ready`, so a half-written card never
 * becomes a run.
 */
export interface OrchestrationProposal {
  version: 1;
  id: string;
  project: string;
  lead: string;
  leadAgent: ConversationAgent;
  /** What the user asked for. */
  request: string;
  status: ProposalStatus;
  title: string;
  summary: string;
  maxWorkers: number;
  /**
   * The {@link TeamLead} preset the plan was made with, by id; null for none
   * (FE-88). `lead` stays the lead's conversation.
   */
  teamLead: string | null;
  tasks: ProposedTask[];
  error: string | null;
}

// ─── Control actions ────────────────────────────────────────────────────────

/** Every action the lead's CLI may send, in the order `--help` lists them. */
export const CONTROL_ACTIONS = [
  "list",
  "delegate",
  "get",
  "wait",
  "respond",
  "answer",
  "steer",
  "message",
  "retry",
  "cancel",
  "review",
  "finish",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export function isControlAction(value: unknown): value is ControlAction {
  return (
    typeof value === "string" &&
    (CONTROL_ACTIONS as readonly string[]).includes(value)
  );
}

/** `delegate`: queue a worker. */
export interface DelegateInput {
  title: string;
  prompt: string;
  /** Absent: the CLI of the tier's model. */
  agent?: ConversationAgent;
  /**
   * Absent: Jev's `model-tier` answer when enforced and sure; otherwise the
   * `standard` tier.
   */
  model?: string;
  effort?: Effort;
  files: string[];
  dependsOn?: string[];
}

/** What each action takes. */
export interface ControlInputs {
  /** The run, every task, and the models `delegate` may name. */
  list: Record<string, never>;
  delegate: DelegateInput;
  /** One task, with its latest result. */
  get: { taskId: string };
  /** Block until a task changes, at most {@link WAIT_MAX_SECONDS}. */
  wait: { timeoutSeconds?: number };
  /** Allow or deny the tool a worker waits on. */
  respond: {
    taskId: string;
    requestId: string;
    decision: "allow" | "deny";
  };
  /**
   * Answer the question a worker asked, by question text, or skip it.
   *
   * Exactly one of `answers` and `skip`.
   */
  answer: {
    taskId: string;
    requestId: string;
    answers?: Record<string, string>;
    skip?: true;
  };
  /** Redirect a running worker without discarding its work. */
  steer: { taskId: string; text: string };
  /** Another turn for a stopped worker, in its own scope and worktree. */
  message: { taskId: string; text: string };
  /** Retry a stopped worker with corrected write scopes. */
  retry: { taskId: string; text: string; files: string[] };
  /** Cancel a running or queued task. */
  cancel: { taskId: string };
  /** Accept a completed task's result. */
  review: { taskId: string };
  /** End the run, once every task is accepted or cancelled. */
  finish: Record<string, never>;
}

/** An action with its checked input. */
export type ControlCall = {
  [A in ControlAction]: { action: A; input: ControlInputs[A] };
}[ControlAction];

/** What each action answers with, under `result`. */
export interface ControlResults {
  list: { run: OrchestrationRun };
  delegate: { taskId: string; task: OrchestrationTask };
  get: { task: OrchestrationTask };
  /** `changed` is empty on a timeout, or when nothing is left to wait on. */
  wait: { run: OrchestrationRun; changed: string[] };
  respond: { task: OrchestrationTask };
  answer: { task: OrchestrationTask };
  steer: { task: OrchestrationTask };
  message: { task: OrchestrationTask };
  retry: { task: OrchestrationTask };
  cancel: { task: OrchestrationTask };
  review: { task: OrchestrationTask };
  finish: { run: OrchestrationRun };
}

/** One line the CLI writes to the control server. */
export interface ControlRequest {
  token: string;
  action: ControlAction;
  input: unknown;
  /** The run applies each id at most once; a retry reuses it. */
  requestId: string;
}

/** One line the control server writes back. */
export type ControlResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: string;
      /** Set when the outcome is unknown: retry with this same id. */
      requestId?: string;
      /** False when retrying cannot help (a refused token, a bad input). */
      retryable?: boolean;
    };

/** The env main sets on the lead's process, and only that process. */
export const CONTROL_ENV = {
  endpoint: "LANEWORK_CONTROL_ENDPOINT",
  token: "LANEWORK_CONTROL_TOKEN",
} as const;

// ─── Validation ─────────────────────────────────────────────────────────────

/** A refused input. The message is meant for the lead to read and fix. */
export class ControlInputError extends Error {
  override name = "ControlInputError";
}

function fail(message: string): never {
  throw new ControlInputError(message);
}

/**
 * `value` as a plain object whose keys are all in `allowed`.
 *
 * @throws When it is not an object, or names a field not in `allowed`.
 */
function strictObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be a JSON object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} must be a JSON object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length)
    fail(
      `${label} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}. Allowed: ${allowed.length ? allowed.join(", ") : "none"}`,
    );
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    fail(`Provide ${label} as a non-empty string`);
  if (value.length > max) fail(`${label} is longer than ${max} characters`);
  return value.trim();
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    fail(`${label} must be 1-64 letters, digits, - or _`);
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value))
    fail(
      `requestId must be 1-${REQUEST_ID_MAX} letters, digits, ".", ":", - or _`,
    );
  return value;
}

/** A worker's CLI: Claude, Codex or OpenCode (FE-105). */
function agent(value: unknown, label = "agent"): ConversationAgent {
  if (!(WORKER_AGENTS as readonly unknown[]).includes(value))
    fail(`${label} must be "claude", "codex" or "opencode"`);
  return value as ConversationAgent;
}

/** A lead's CLI: Claude or Codex, never OpenCode (FE-105/D5). */
function leadAgent(value: unknown, label = "leadAgent"): LeadAgent {
  if (value === "opencode")
    fail(
      `${label} cannot be "opencode": OpenCode runs only as a worker. Lead with Claude or Codex`,
    );
  if (!canLead(value as ConversationAgent))
    fail(`${label} must be "claude" or "codex"`);
  return value as LeadAgent;
}

/**
 * A model id: a plain name (Claude, Codex) or OpenCode's `provider/model`.
 * Given `on`, the id must have that CLI's shape.
 */
function model(
  value: unknown,
  label = "model",
  on: ConversationAgent | null = null,
): string {
  if (typeof value !== "string") fail(`${label} must be a model id from list`);
  const plain = MODEL_ID_PATTERN.test(value);
  const opencode = OPENCODE_MODEL_ID.test(value);
  if (on === "opencode" ? !opencode : on ? !plain : !plain && !opencode)
    fail(
      on === "opencode"
        ? `${label} must be an OpenCode model id from list (provider/model)`
        : `${label} must be a model id from list`,
    );
  return value;
}

function effort(value: unknown, label = "effort"): Effort {
  if (
    typeof value !== "string" ||
    !(EFFORTS as readonly string[]).includes(value)
  )
    fail(`${label} must be one of ${EFFORTS.join(", ")}`);
  return value as Effort;
}

/**
 * One write scope, project-relative and normalised: `./src//a/` → `src/a`.
 *
 * @throws On an absolute path, a drive letter, or a `..` segment.
 */
export function scopePath(value: unknown, label = "files"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    fail(`Each entry of ${label} must be a non-empty path`);
  const slashed = value.trim().replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed))
    fail(
      `${label} entry "${value}" is absolute. Use a project-relative path, or "." for the whole checkout`,
    );
  const parts = slashed.split("/").filter((part) => part && part !== ".");
  if (parts.includes(".."))
    fail(`${label} entry "${value}" leaves the checkout through ".."`);
  return parts.join("/") || ".";
}

/** Write scopes; `[]` is a read-only task, which may write no file at all. */
function scopes(value: unknown, label = "files"): string[] {
  if (!Array.isArray(value) || value.length > FILES_MAX)
    fail(
      `${label} must list at most ${FILES_MAX} project-relative paths, or [] for a task that edits no file`,
    );
  return [...new Set(value.map((entry) => scopePath(entry, label)))];
}

function idList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > TASKS_MAX)
    fail(`${label} must list at most ${TASKS_MAX} task ids`);
  return [...new Set(value.map((entry) => id(entry, `Each of ${label}`)))];
}

function answers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("answers must be an object of question text to answer");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 8)
    fail("answers must hold 1-8 answers");
  return Object.fromEntries(
    entries.map(([question, answer]) => [
      text(question, "a question", 2000),
      text(answer, "an answer", 2000),
    ]),
  );
}

type Parsers = {
  [A in ControlAction]: (input: Record<string, unknown>) => ControlInputs[A];
};

/** Each action's fields, and how they are checked. */
const SCHEMAS: {
  [A in ControlAction]: { fields: readonly string[]; parse: Parsers[A] };
} = {
  list: { fields: [], parse: () => ({}) },
  delegate: {
    fields: [
      "title",
      "prompt",
      "agent",
      "model",
      "effort",
      "files",
      "dependsOn",
    ],
    parse: (input) => {
      const out: DelegateInput = {
        title: text(input.title, "title", TITLE_MAX),
        prompt: text(input.prompt, "prompt", PROMPT_MAX),
        files: scopes(input.files),
      };
      if (input.agent !== undefined) out.agent = agent(input.agent);
      if (input.model !== undefined)
        out.model = model(input.model, "model", out.agent ?? null);
      if (input.effort !== undefined) out.effort = effort(input.effort);
      if (input.dependsOn !== undefined)
        out.dependsOn = idList(input.dependsOn, "dependsOn");
      return out;
    },
  },
  get: {
    fields: ["taskId"],
    parse: (input) => ({ taskId: id(input.taskId, "taskId") }),
  },
  wait: {
    fields: ["timeoutSeconds"],
    parse: (input) => {
      if (input.timeoutSeconds === undefined) return {};
      const seconds = input.timeoutSeconds;
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > WAIT_MAX_SECONDS
      )
        fail(`timeoutSeconds must be 0-${WAIT_MAX_SECONDS}`);
      return { timeoutSeconds: seconds };
    },
  },
  respond: {
    fields: ["taskId", "requestId", "decision"],
    parse: (input) => {
      if (input.decision !== "allow" && input.decision !== "deny")
        fail('decision must be "allow" or "deny"');
      return {
        taskId: id(input.taskId, "taskId"),
        requestId: requestId(input.requestId),
        decision: input.decision,
      };
    },
  },
  answer: {
    fields: ["taskId", "requestId", "answers", "skip"],
    parse: (input) => {
      const base = {
        taskId: id(input.taskId, "taskId"),
        requestId: requestId(input.requestId),
      };
      const hasAnswers = input.answers !== undefined;
      const hasSkip = input.skip !== undefined;
      if (hasAnswers === hasSkip)
        fail('Pass exactly one of "answers" and "skip": true');
      if (hasSkip) {
        if (input.skip !== true) fail("skip must be true");
        return { ...base, skip: true };
      }
      return { ...base, answers: answers(input.answers) };
    },
  },
  steer: {
    fields: ["taskId", "text"],
    parse: (input) => ({
      taskId: id(input.taskId, "taskId"),
      text: text(input.text, "text", PROMPT_MAX),
    }),
  },
  message: {
    fields: ["taskId", "text"],
    parse: (input) => ({
      taskId: id(input.taskId, "taskId"),
      text: text(input.text, "text", PROMPT_MAX),
    }),
  },
  retry: {
    fields: ["taskId", "text", "files"],
    parse: (input) => ({
      taskId: id(input.taskId, "taskId"),
      text: text(input.text, "text", PROMPT_MAX),
      files: scopes(input.files),
    }),
  },
  cancel: {
    fields: ["taskId"],
    parse: (input) => ({ taskId: id(input.taskId, "taskId") }),
  },
  review: {
    fields: ["taskId"],
    parse: (input) => ({ taskId: id(input.taskId, "taskId") }),
  },
  finish: { fields: [], parse: () => ({}) },
};

// The checks a conductor's `sessions.*` actions share (conductor-sessions.ts).
export {
  effort as controlEffort,
  requestId as controlRequestId,
  strictObject as controlObject,
  text as controlText,
};

/** The fields each action takes, for `--help` and error messages. */
export function controlFields(action: ControlAction): readonly string[] {
  return SCHEMAS[action].fields;
}

/**
 * Check one control call: a known action, and an input with only its fields.
 *
 * Shapes only. Whether a task exists, a model is allowed or a scope is free
 * is the run's to say.
 *
 * @throws {ControlInputError} On an unknown action, an unknown or missing
 *   field, or a value of the wrong shape.
 */
export function parseControlInput(
  action: unknown,
  input: unknown,
): ControlCall {
  if (!isControlAction(action))
    fail(
      `Unknown action ${JSON.stringify(action)}. Use one of: ${CONTROL_ACTIONS.join(", ")}`,
    );
  const schema = SCHEMAS[action] as {
    fields: readonly string[];
    parse: (input: Record<string, unknown>) => unknown;
  };
  const checked = strictObject(input ?? {}, schema.fields, `${action}'s input`);
  return { action, input: schema.parse(checked) } as ControlCall;
}

/**
 * Check one line from the CLI: the envelope, then the action's input.
 *
 * @throws {ControlInputError} On anything {@link parseControlInput} refuses,
 *   or an envelope with a missing or unknown field.
 */
export function parseControlRequest(
  value: unknown,
): ControlCall & { token: string; requestId: string } {
  const envelope = strictObject(
    value,
    ["token", "action", "input", "requestId"],
    "The request",
  );
  if (typeof envelope.token !== "string" || !envelope.token)
    fail("The request carries no token");
  const call = parseControlInput(envelope.action, envelope.input);
  return {
    ...call,
    token: envelope.token,
    requestId: requestId(envelope.requestId),
  };
}

/**
 * Check a proposal's tasks before any of them may run: shapes, unique ids,
 * known dependencies, no cycle.
 *
 * Whether each agent/model pair is allowed is the caller's to check against
 * the run's choices.
 *
 * @throws {ControlInputError} On the first problem found.
 */
export function parseProposedTasks(value: unknown): ProposedTask[] {
  if (!Array.isArray(value) || !value.length || value.length > TASKS_MAX)
    fail(`Provide 1-${TASKS_MAX} tasks`);
  const tasks = value.map((entry, index): ProposedTask => {
    const label = `Task ${index + 1}`;
    const task = strictObject(
      entry,
      [
        "id",
        "title",
        "prompt",
        "agent",
        "model",
        "effort",
        "files",
        "dependsOn",
      ],
      label,
    );
    const on =
      task.agent == null ? null : agent(task.agent, `${label}'s agent`);
    return {
      id: id(task.id, `${label}'s id`),
      title: text(task.title, `${label}'s title`, TITLE_MAX),
      prompt: text(task.prompt, `${label}'s prompt`, PROMPT_MAX),
      agent: on,
      model:
        task.model == null ? null : model(task.model, `${label}'s model`, on),
      effort:
        task.effort == null ? null : effort(task.effort, `${label}'s effort`),
      files: scopes(task.files, `${label}'s files`),
      dependsOn: idList(task.dependsOn ?? [], `${label}'s dependsOn`),
    };
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) fail("Task ids must be unique");
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string) => {
    const task = byId.get(key);
    if (!task) fail(`A dependency names an unknown task "${key}"`);
    if (visiting.has(key)) fail("The tasks' dependencies form a cycle");
    if (done.has(key)) return;
    visiting.add(key);
    for (const next of task.dependsOn) visit(next);
    visiting.delete(key);
    done.add(key);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

/**
 * Check a proposal the renderer asks main to approve.
 *
 * Only a `ready` proposal may be approved; its tasks go through
 * {@link parseProposedTasks}.
 *
 * @throws {ControlInputError} On a missing or unknown field, or a bad value.
 */
export function parseProposal(value: unknown): OrchestrationProposal {
  const input = strictObject(
    value,
    [
      "version",
      "id",
      "project",
      "lead",
      "leadAgent",
      "request",
      "status",
      "title",
      "summary",
      "maxWorkers",
      "teamLead",
      "tasks",
      "error",
    ],
    "The proposal",
  );
  // NOTE: Absent reads as null, so a card written before FE-88 still approves.
  const teamLead =
    input.teamLead == null ? null : leadRef(input.teamLead, "teamLead");
  if (input.version !== 1) fail("Unknown proposal version");
  if (input.status !== "ready") fail("Only a ready proposal can be approved");
  if (typeof input.project !== "string" || !input.project)
    fail("project must be a slug");
  if (typeof input.lead !== "string" || !input.lead)
    fail("lead must be a conversation id");
  if (
    !Number.isInteger(input.maxWorkers) ||
    (input.maxWorkers as number) < 1 ||
    (input.maxWorkers as number) > WORKERS_MAX
  )
    fail(`maxWorkers must be 1-${WORKERS_MAX}`);
  return {
    version: 1,
    id: id(input.id, "id"),
    project: input.project,
    lead: input.lead,
    leadAgent: leadAgent(input.leadAgent),
    request: text(input.request, "request", PROMPT_MAX),
    status: "ready",
    title: text(input.title, "title", TITLE_MAX),
    summary: text(input.summary, "summary", 2000),
    maxWorkers: input.maxWorkers as number,
    teamLead,
    tasks: parseProposedTasks(input.tasks),
    error: null,
  };
}

// ─── Jev ────────────────────────────────────────────────────────────────────
//
// Jev answers small, bounded questions — pick one of these options — with a
// calibrated probability, so the lead's expensive model is asked only when
// Jev is unsure. Every answer below its point's threshold, or made while the
// point is in shadow, goes to the lead as if Jev were not there.
//
// NOTE: Jev never decides an irreversible action (D12). The caller does not
// ask it about one; `permission` is for read-only allows and plain denies.

/** Where the judge runs. */
export const JEV_PROVIDERS = ["openrouter", "typesafe", "local"] as const;
export type JevProvider = (typeof JEV_PROVIDERS)[number];

/**
 * What Jev may be asked about (D11).
 *
 * - `model-tier`: which tier a delegated task runs on.
 * - `permission`: allow a read-only tool, or deny one plainly out of bounds.
 * - `report`: whether a worker's final report says its checks passed.
 */
export const JUDGE_POINTS = ["model-tier", "permission", "report"] as const;
export type JudgePoint = (typeof JUDGE_POINTS)[number];

/** Shadow: answer and log, never act. Enforce: act above the threshold. */
export const JUDGE_MODES = ["shadow", "enforce"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export interface JudgePointConfig {
  mode: JudgeMode;
  /** 0-1: Jev acts only when its probability reaches this. */
  threshold: number;
}

/** The model a tier runs on. */
export interface TierModel {
  agent: ConversationAgent;
  model: string;
  effort: Effort | null;
}

/**
 * Jev's settings.
 *
 * NOTE: The API key is not here. It goes to main alone, through
 * {@link DesktopJevApi.setKey}, is kept with `safeStorage`, and never reaches
 * the page, an agent's env or a log; the page only learns `hasKey`.
 */
export interface JevConfig {
  /** Null: Jev is off and the lead decides everything (D14). */
  provider: JevProvider | null;
  /**
   * The API base URL. Empty: the provider's own (OpenRouter, TypeSafe).
   * Required for `local`: an OpenAI-compatible server the user runs, such as
   * Ollama, llama.cpp or LM Studio (D10).
   */
  endpoint: string;
  /** The judge's model id at the provider. */
  model: string;
  points: Record<JudgePoint, JudgePointConfig>;
  /** What `model-tier` picks between. */
  tiers: Record<Tier, TierModel>;
}

/** Main's view of the config for the page: the config, and whether a key is kept. */
export interface JevState {
  config: JevConfig;
  hasKey: boolean;
}

/** One bounded question. */
export interface JudgeRequest {
  point: JudgePoint;
  question: string;
  /** 2-16 distinct options; Jev answers with exactly one of them. */
  options: string[];
  /** What Jev may read to answer: the task, the tool call, the report. */
  context: string;
}

/** Jev's answer to one question. */
export interface JudgeResult {
  point: JudgePoint;
  /** One of the request's options; null when Jev could not answer. */
  choice: string | null;
  /** Jev's probability for `choice`, 0-1; 0 when it could not answer. */
  p: number;
  mode: JudgeMode;
  /**
   * Whether the caller may act on `choice`: enforce mode, and `p` reached the
   * threshold. False: escalate to the lead.
   */
  decided: boolean;
  /**
   * - `judge`: the provider answered.
   * - `off`: no provider is set.
   * - `error`: the provider failed; `error` says how.
   */
  source: "judge" | "off" | "error";
  error: string | null;
  /** The shadow-log entry this answer was written to. */
  logId: string;
}

/** One line of Jev's log: what it answered, and what was done in the end. */
export interface JudgeLogEntry {
  id: string;
  at: number;
  point: JudgePoint;
  question: string;
  options: string[];
  choice: string | null;
  p: number;
  mode: JudgeMode;
  decided: boolean;
  /** What the lead (or Jev, when decided) chose; null until known. */
  outcome: string | null;
}

/** The most a judge request's context may weigh, in characters. */
export const JUDGE_CONTEXT_MAX = 20_000;

/**
 * A tier's model, or a team lead's own (`lead`: Claude or Codex only). A
 * tier's runs a worker, so it may be OpenCode's (FE-105).
 */
function tierModel(value: unknown, label: string, lead = false): TierModel {
  const input = strictObject(value, ["agent", "model", "effort"], label);
  const on = lead
    ? leadAgent(input.agent, `${label}'s agent`)
    : agent(input.agent, `${label}'s agent`);
  return {
    agent: on,
    model: model(input.model, `${label}'s model`, on),
    effort:
      input.effort == null ? null : effort(input.effort, `${label}'s effort`),
  };
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

function pointConfig(value: unknown, label: string): JudgePointConfig {
  const input = strictObject(value, ["mode", "threshold"], label);
  const threshold = input.threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  )
    fail(`${label}'s threshold must be 0-1`);
  return { mode: oneOf(input.mode, JUDGE_MODES, `${label}'s mode`), threshold };
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 512)
    fail("endpoint must be a URL, or empty");
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    fail("endpoint must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    fail("endpoint must be an http(s) URL");
  if (url.username || url.password)
    fail("endpoint must not carry credentials; set the API key instead");
  // Plain http sends the API key in clear: only to this machine (D10).
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
    fail(
      "endpoint must use https, or http only on this machine (localhost, 127.0.0.1, ::1)",
    );
  return trimmed.replace(/\/+$/, "");
}

/** The hosts plain http may reach: `URL.hostname` keeps IPv6's brackets. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin Jev's key is sent to: the endpoint's, or the provider's own
 * when it is empty. Null when Jev is off.
 *
 * NOTE: The key is kept for one provider and one origin (D10). Changing
 * either forgets it, so a key typed for OpenRouter never reaches a server
 * the endpoint field was later pointed at.
 */
export function jevKeyOrigin(
  config: Pick<JevConfig, "provider" | "endpoint">,
): string | null {
  if (!config.provider) return null;
  const base = config.endpoint || JEV_DEFAULT_ENDPOINTS[config.provider];
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** Each provider's own API base; `local` has none. */
export const JEV_DEFAULT_ENDPOINTS: Record<JevProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  typesafe: "https://api.typesafe.ai",
  local: "",
};

/**
 * Check a Jev config from the renderer or from disk.
 *
 * @throws {ControlInputError} On a missing or unknown field, or a bad value.
 */
export function parseJevConfig(value: unknown): JevConfig {
  const input = strictObject(
    value,
    ["provider", "endpoint", "model", "points", "tiers"],
    "Jev's config",
  );
  const provider =
    input.provider === null
      ? null
      : oneOf(input.provider, JEV_PROVIDERS, "provider");
  const url = endpoint(input.endpoint);
  if (provider === "local" && !url)
    fail("A local judge needs the endpoint of its OpenAI-compatible server");
  if (typeof input.model !== "string" || input.model.length > 200)
    fail("model must be a model id");
  const judgeModel = input.model.trim();
  if (provider && !judgeModel) fail("Name the judge's model");
  const points = strictObject(input.points, JUDGE_POINTS, "Jev's points");
  const tiers = strictObject(input.tiers, TIERS, "Jev's tiers");
  return {
    provider,
    endpoint: url,
    model: judgeModel,
    points: {
      "model-tier": pointConfig(points["model-tier"], "model-tier"),
      permission: pointConfig(points.permission, "permission"),
      report: pointConfig(points.report, "report"),
    },
    tiers: {
      light: tierModel(tiers.light, "light"),
      standard: tierModel(tiers.standard, "standard"),
      heavy: tierModel(tiers.heavy, "heavy"),
    },
  };
}

/**
 * Check a judge request (Settings' Test connection, or main's own callers).
 *
 * @throws {ControlInputError} On a missing or unknown field, or a bad value.
 */
export function parseJudgeRequest(value: unknown): JudgeRequest {
  const input = strictObject(
    value,
    ["point", "question", "options", "context"],
    "The judge request",
  );
  if (
    !Array.isArray(input.options) ||
    input.options.length < 2 ||
    input.options.length > 16
  )
    fail("options must list 2-16 choices");
  const options = input.options.map((option) => text(option, "an option", 200));
  if (new Set(options).size !== options.length)
    fail("options must be distinct");
  if (
    typeof input.context !== "string" ||
    input.context.length > JUDGE_CONTEXT_MAX
  )
    fail(`context must be a string of at most ${JUDGE_CONTEXT_MAX} characters`);
  return {
    point: oneOf(input.point, JUDGE_POINTS, "point"),
    question: text(input.question, "question", 2000),
    options,
    context: input.context,
  };
}

/**
 * Check an API key the page hands main. Null forgets the kept key.
 *
 * @throws {ControlInputError} On anything but a short single-line string.
 */
export function parseJevKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 1024)
    fail("The API key must be a non-empty string");
  if (/[\r\n]/.test(value)) fail("The API key must be one line");
  return value.trim();
}

// ─── Team leads (FE-88) ─────────────────────────────────────────────────────
//
// A team lead is a preset for `/orchestrate`: who leads, what it is told,
// which workers it may hand work to, how many at once, the checks a worker's
// report must cover, and Jev overrides. The user picks one on the proposal
// card; the run keeps its id.
//
// Two places hold them, and `list` merges them in this order (none ships
// with the app since FE-95):
//
// - `personal`: the user's own, saved from the rail, for every project.
// - `repo`: `.lanework/leads/<id>.md` a project checks in, frontmatter plus
//   instructions. Its id is `repo:<id>` (D3), so it never shadows a personal
//   lead, and it may not override Jev (D1). One that fails to parse is left
//   out and reported in {@link LeadsList.errors}, never half-read.

/** What a team lead's id may be: a slug, also its file name in a repo. */
export const LEAD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * What names a team lead anywhere (D3): a built-in or personal lead's id, or
 * `repo:` and a repo file's stem. A repo lead lives in its own namespace, so
 * a file a project checks in never stands in for a lead the user trusts.
 */
export const LEAD_REF_PATTERN = /^(?:repo:)?[a-z0-9][a-z0-9-]{0,47}$/;
/** What a repo lead's id starts with. */
export const REPO_LEAD_PREFIX = "repo:";
/** The longest a team lead's name may be. */
export const LEAD_NAME_MAX = 60;
/** The longest a team lead's instructions may be. */
export const LEAD_INSTRUCTIONS_MAX = 20_000;
/** The most workers one team lead may list. */
export const LEAD_WORKERS_MAX = 16;
/** The most checks one team lead may list. */
export const LEAD_CHECKS_MAX = 8;
/** The longest one check may be. */
export const LEAD_CHECK_MAX = 300;
/** The most context files one conductor may list (FE-96). */
export const LEAD_CONTEXT_FILES_MAX = 20;
/** The longest one context file's path may be. */
export const LEAD_CONTEXT_PATH_MAX = 1024;

/** Where a team lead comes from. */
export const LEAD_SOURCES = ["personal", "repo"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * The icons a team lead may wear: Hugeicons names the app already draws, so
 * the page maps each to its component without loading any other.
 */
export const LEAD_ICONS = [
  "Robot02Icon",
  "Brain02Icon",
  "Flowchart01Icon",
  "Target02Icon",
  "Shield01Icon",
  "MagicWand01Icon",
  "SparklesIcon",
  "Wrench01Icon",
  "Layers01Icon",
  "Idea01Icon",
  "FlashIcon",
  "AiChipIcon",
] as const;
export type LeadIcon = (typeof LEAD_ICONS)[number];

/** A worker a team lead may hand work to: Claude, Codex or OpenCode (FE-105). */
export interface TeamLeadWorker {
  agent: ConversationAgent;
  model: string;
  /** Jev's tier this worker stands for; null when it stands for none. */
  tier: Tier | null;
}

export interface TeamLead {
  id: string;
  name: string;
  icon: LeadIcon;
  /** The lead's own CLI (Claude or Codex, never OpenCode: FE-105), model and effort. */
  lead: TierModel;
  /** Told to the lead before the user's request; may be empty. */
  instructions: string;
  /**
   * Files and folders in the project it reads before it answers or plans
   * (FE-96): project-relative, `/`-separated, never absolute or `..`. Only
   * the paths travel; it reads them itself, so it always sees the latest.
   */
  contextFiles: string[];
  /**
   * 0-{@link LEAD_WORKERS_MAX} distinct agent/model pairs. None (FE-95): it
   * picks from every model the app offers, as a run without a lead does, and
   * the Decision judge picks the tier when one is set.
   */
  workers: TeamLeadWorker[];
  /** 1-{@link WORKERS_MAX}. */
  maxWorkers: number;
  /** One line each: what a worker's report must show before it is accepted. */
  checks: string[];
  /**
   * Points that differ from Jev's settings for runs under this lead; null for
   * none. Always null for a `repo` lead (D1).
   */
  jev: Partial<Record<JudgePoint, JudgePointConfig>> | null;
  /**
   * What its own conversation may do without asking (FE-95); null for the
   * composer's default. Always null for a `repo` lead, as `jev` is.
   */
  permission: Permission | null;
  source: LeadSource;
}

/**
 * What a new conductor starts with, and keeps: the rail's dialog has no
 * page for them (FE-95). No workers, so it picks from every model and the
 * Decision judge picks the tier; three at once; no required checks.
 */
export const CONDUCTOR_DEFAULTS = {
  workers: [] as readonly TeamLeadWorker[],
  maxWorkers: 3,
  checks: [] as readonly string[],
} as const;

/**
 * A new conductor's instructions: the sections agent instructions usually
 * have, each with a hint for the person writing them (FE-95). The hints are
 * HTML comments, left out of what the conductor is told
 * (`withoutComments`), so an unfilled section costs nothing.
 */
export const CONDUCTOR_INSTRUCTIONS = `## Role
<!-- What it leads, and what a good outcome looks like. -->

## Approach
<!-- How it splits work, what it does itself, what it hands to workers. -->

## Rules
<!-- Hard limits: files it must not touch, commands it must not run. -->

## Done means
<!-- What must be true before it reports back: checks, tests, a summary. -->
`;

/**
 * `text` without its HTML comments, and without the headings left with
 * nothing under them: an unfilled template reads as no instructions.
 */
export function withoutComments(text: string): string {
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const kept = lines.filter((line, index) => {
    if (!/^#{1,6}\s/.test(line)) return true;
    // A heading stays when something other than blank lines comes before the
    // next heading of the same or a higher level, or the end.
    const level = /^#+/.exec(line)?.[0].length ?? 1;
    for (const next of lines.slice(index + 1)) {
      const heading = /^(#{1,6})\s/.exec(next);
      if (heading && (heading[1]?.length ?? 1) <= level) return false;
      if (next.trim() && !heading) return true;
      if (heading) return true;
    }
    return false;
  });
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A team lead as the page saves it: the source is main's to set. */
export type TeamLeadInput = Omit<TeamLead, "source">;

/** Every team lead a project sees, and the repo files that were refused. */
export interface LeadsList {
  leads: TeamLead[];
  /** The one the proposal card starts on; null for none. */
  defaultId: string | null;
  /** `file` is repo-relative. */
  errors: { file: string; error: string }[];
}

/**
 * A team lead's id.
 *
 * @throws {ControlInputError} When it is not a {@link LEAD_ID_PATTERN} slug.
 */
export function leadId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !LEAD_ID_PATTERN.test(value))
    fail(
      `${label} must be 1-48 lowercase letters, digits or -, starting with a letter or digit`,
    );
  return value;
}

/**
 * A reference to a team lead: a built-in or personal id, or `repo:<stem>`.
 *
 * @throws {ControlInputError} When it is not a {@link LEAD_REF_PATTERN} ref.
 */
export function leadRef(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !LEAD_REF_PATTERN.test(value))
    fail(
      `${label} must be a team lead's id, or repo: and the id of one in .lanework/leads`,
    );
  return value;
}

function oneLine(value: unknown, label: string, max: number): string {
  const line = text(value, label, max);
  if (/[\r\n]/.test(line)) fail(`${label} must be one line`);
  return line;
}

/**
 * One context file's path, as `TeamLead.contextFiles` keeps it: relative to
 * the project, `/` between parts, no `./`, no trailing `/`.
 *
 * @throws {ControlInputError} When it is empty, absolute, or climbs out.
 */
export function contextPath(value: unknown, label = "Context file"): string {
  const raw = oneLine(value, label, LEAD_CONTEXT_PATH_MAX);
  if (raw.includes("\\")) fail(`${label} must use / between folders`);
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw))
    fail(`${label} must be relative to the project, not absolute`);
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!parts.length) fail(`${label} must name a file or folder in the project`);
  if (parts.includes(".."))
    fail(`${label} must stay inside the project: no ..`);
  return parts.join("/");
}

function leadContextFiles(value: unknown): string[] {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > LEAD_CONTEXT_FILES_MAX)
    fail(`contextFiles must list at most ${LEAD_CONTEXT_FILES_MAX} paths`);
  return [
    ...new Set(
      list.map((entry, index) =>
        contextPath(entry, `Context file ${index + 1}`),
      ),
    ),
  ];
}

function leadWorkers(value: unknown): TeamLeadWorker[] {
  if (!Array.isArray(value) || value.length > LEAD_WORKERS_MAX)
    fail(`workers must list at most ${LEAD_WORKERS_MAX} workers`);
  const workers = value.map((entry, index): TeamLeadWorker => {
    const label = `Worker ${index + 1}`;
    const input = strictObject(entry, ["agent", "model", "tier"], label);
    const on = agent(input.agent, `${label}'s agent`);
    return {
      agent: on,
      model: model(input.model, `${label}'s model`, on),
      tier:
        input.tier == null ? null : oneOf(input.tier, TIERS, `${label}'s tier`),
    };
  });
  const pairs = new Set(
    workers.map((worker) => `${worker.agent}/${worker.model}`),
  );
  if (pairs.size !== workers.length)
    fail("workers must not list the same agent and model twice");
  return workers;
}

function leadJev(
  value: unknown,
): Partial<Record<JudgePoint, JudgePointConfig>> | null {
  if (value == null) return null;
  const input = strictObject(value, JUDGE_POINTS, "jev");
  const out: Partial<Record<JudgePoint, JudgePointConfig>> = {};
  for (const point of JUDGE_POINTS)
    if (input[point] !== undefined)
      out[point] = pointConfig(input[point], `jev's ${point}`);
  return Object.keys(out).length ? out : null;
}

/**
 * Check a team lead from the page, a repo file or the personal store.
 *
 * `source` is the caller's to say: a `source` field in `value` is allowed (a
 * lead read back from `list`) but never trusted.
 *
 * @throws {ControlInputError} On a missing or unknown field, or a bad value.
 */
export function parseTeamLead(value: unknown, source: LeadSource): TeamLead {
  const input = strictObject(
    value,
    [
      "id",
      "name",
      "icon",
      "lead",
      "instructions",
      "contextFiles",
      "workers",
      "maxWorkers",
      "checks",
      "jev",
      "permission",
      "source",
    ],
    "The team lead",
  );
  if (
    !Number.isInteger(input.maxWorkers) ||
    (input.maxWorkers as number) < 1 ||
    (input.maxWorkers as number) > WORKERS_MAX
  )
    fail(`maxWorkers must be 1-${WORKERS_MAX}`);
  if (
    typeof input.instructions !== "string" ||
    input.instructions.length > LEAD_INSTRUCTIONS_MAX
  )
    fail(
      `instructions must be a string of at most ${LEAD_INSTRUCTIONS_MAX} characters`,
    );
  const checks = input.checks ?? [];
  if (!Array.isArray(checks) || checks.length > LEAD_CHECKS_MAX)
    fail(`checks must list at most ${LEAD_CHECKS_MAX} lines`);
  // A project's file may not loosen Jev for the person who opens it (D1):
  // only a lead the user wrote, or one shipped with the app, overrides it.
  if (source === "repo" && input.jev != null)
    fail(
      "jev is not allowed in a project's team lead. Set Jev overrides on a personal lead instead",
    );
  // Nor grant its conversation more than the user picks (FE-95).
  if (source === "repo" && input.permission != null)
    fail(
      "permission is not allowed in a project's conductor. Set it on a personal one instead",
    );
  // A repo lead's id is always `repo:<stem>` (D3), whatever the file said.
  const id =
    source === "repo"
      ? `${REPO_LEAD_PREFIX}${leadId(
          typeof input.id === "string" && input.id.startsWith(REPO_LEAD_PREFIX)
            ? input.id.slice(REPO_LEAD_PREFIX.length)
            : input.id,
        )}`
      : leadId(input.id);
  return {
    id,
    name: oneLine(input.name, "name", LEAD_NAME_MAX),
    icon: oneOf(input.icon, LEAD_ICONS, "icon"),
    lead: tierModel(input.lead, "lead", true),
    instructions: input.instructions.trim(),
    contextFiles: leadContextFiles(input.contextFiles),
    workers: leadWorkers(input.workers),
    maxWorkers: input.maxWorkers as number,
    checks: [
      ...new Set(
        checks.map((check, index) =>
          oneLine(check, `Check ${index + 1}`, LEAD_CHECK_MAX),
        ),
      ),
    ],
    jev: leadJev(input.jev),
    permission:
      input.permission == null
        ? null
        : oneOf(input.permission, PERMISSIONS, "permission"),
    source: oneOf(source, LEAD_SOURCES, "source"),
  };
}

// ─── IPC ────────────────────────────────────────────────────────────────────

export const orchestrationChannels = {
  /** The project's runs, newest first. */
  runs: "orchestration:runs",
  run: "orchestration:run",
  /** Approve a proposal: the run starts with its tasks queued. */
  approve: "orchestration:approve",
  pause: "orchestration:pause",
  /** Continue a paused run; interrupted workers resume in their worktrees. */
  resume: "orchestration:resume",
  stop: "orchestration:stop",
  /** The user cancels one task from the run's panel. */
  cancelTask: "orchestration:cancel-task",
  /** The user approves the wider write scopes a queued task waits on (D11). */
  approveScope: "orchestration:approve-scope",
  /** What a stopped run left behind in git (FE-100/O2). */
  leftovers: "orchestration:leftovers",
  /** Remove what a stopped run left behind, after the user confirmed. */
  cleanUp: "orchestration:clean-up",
  /** Main → renderer: a run changed. */
  changed: "orchestration:changed",
} as const;

export const jevChannels = {
  get: "jev:get",
  set: "jev:set",
  /** Keep or forget the provider's API key; main alone holds it. */
  setKey: "jev:set-key",
  /** Ask one question now (Settings → Test connection). */
  test: "jev:test",
  /** The newest log entries, to compare Jev with the lead in shadow. */
  log: "jev:log",
  /** Main → renderer: the config or the key changed. */
  changed: "jev:changed",
} as const;

export const leadsChannels = {
  /** Built-in, personal and the project's repo leads, merged; null: no repo. */
  list: "leads:list",
  /** Add or replace one of the user's own leads, by id. */
  savePersonal: "leads:save-personal",
  removePersonal: "leads:remove-personal",
  /** The lead a new proposal starts on, or null for none. */
  setDefault: "leads:set-default",
  /** Ask the user for context files in the project (FE-96). */
  pickContext: "leads:pick-context",
  /** Whether each context file is a file, a folder, or gone. */
  inspectContext: "leads:inspect-context",
  /** Main → renderer: the leads changed. */
  changed: "leads:changed",
} as const;

/**
 * Main → renderer, on {@link leadsChannels.changed}: which project's repo
 * leads changed, or null when the personal leads or the default did.
 */
export interface LeadsEvent {
  project: string | null;
}

/** A context file as it stands in the checkout now (FE-96). */
export interface ContextEntry {
  path: string;
  kind: "file" | "folder" | "missing";
}

/** What the user picked for a conductor's context. */
export interface ContextPick {
  /** Project-relative, as {@link contextPath} keeps them. */
  paths: string[];
  /** How many picks were outside the project, and left out. */
  outside: number;
}

/** Main → renderer, on {@link orchestrationChannels.changed}. */
export interface OrchestrationEvent {
  project: string;
  run: OrchestrationRun;
}

/**
 * The orchestration surface in the renderer.
 *
 * Every call names a project slug and ids main minted, never a folder.
 */
export interface DesktopOrchestrationApi {
  runs: (project: string) => Promise<OrchestrationRun[]>;
  run: (project: string, runId: string) => Promise<OrchestrationRun | null>;
  approve: (proposal: OrchestrationProposal) => Promise<OrchestrationRun>;
  pause: (project: string, runId: string) => Promise<OrchestrationRun>;
  resume: (project: string, runId: string) => Promise<OrchestrationRun>;
  stop: (project: string, runId: string) => Promise<OrchestrationRun>;
  cancelTask: (
    project: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
  approveScope: (
    project: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
  leftovers: (project: string, runId: string) => Promise<RunLeftovers>;
  cleanUp: (project: string, runId: string) => Promise<OrchestrationRun>;
  onChange: (listener: (event: OrchestrationEvent) => void) => () => void;
}

/** Jev's settings, test and log in the renderer. */
export interface DesktopJevApi {
  get: () => Promise<JevState>;
  set: (config: JevConfig) => Promise<JevState>;
  setKey: (key: string | null) => Promise<JevState>;
  test: (request: JudgeRequest) => Promise<JudgeResult>;
  log: () => Promise<JudgeLogEntry[]>;
  onChange: (listener: (state: JevState) => void) => () => void;
}

/**
 * Team leads in the renderer (FE-88).
 *
 * The page saves and removes only personal leads; built-in ones ship with the
 * app and repo ones are files the project checks in. Every call that changes
 * something answers with the list as it now stands.
 */
export interface DesktopLeadsApi {
  list: (project: string | null) => Promise<LeadsList>;
  /** Conductors are the project's own (FE-95): every write names it. */
  savePersonal: (project: string, lead: TeamLeadInput) => Promise<LeadsList>;
  removePersonal: (project: string, id: string) => Promise<LeadsList>;
  setDefault: (project: string, id: string | null) => Promise<LeadsList>;
  /** The native chooser, opened on the project's folder (FE-96). */
  pickContext: (project: string) => Promise<ContextPick>;
  inspectContext: (project: string, paths: string[]) => Promise<ContextEntry[]>;
  onChange: (listener: (event: LeadsEvent) => void) => () => void;
}

// ─── Main-side seams ────────────────────────────────────────────────────────

/**
 * What the run engine (W1) hands `main/index.ts`: one handler per IPC call
 * and per control action.
 *
 * Arguments reach these already checked: ids are {@link ID_PATTERN}, a
 * proposal went through {@link parseProposedTasks}, a control input through
 * {@link parseControlInput}.
 */
export interface OrchestrationMainHandlers {
  runs: (project: string) => Promise<OrchestrationRun[]>;
  run: (project: string, runId: string) => Promise<OrchestrationRun | null>;
  approve: (proposal: OrchestrationProposal) => Promise<OrchestrationRun>;
  pause: (project: string, runId: string) => Promise<OrchestrationRun>;
  resume: (project: string, runId: string) => Promise<OrchestrationRun>;
  stop: (project: string, runId: string) => Promise<OrchestrationRun>;
  cancelTask: (
    project: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
  /**
   * The user approves the write scopes `taskId` waits on
   * ({@link OrchestrationTask.scopeApproval}); they join the run's approved
   * scopes and the task may start.
   */
  approveScope: (
    project: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
  /**
   * What a stopped run left behind (FE-100/O2); refused for a run that is
   * not stopped.
   */
  leftovers: (project: string, runId: string) => Promise<RunLeftovers>;
  /**
   * Remove every worktree, branch and ref {@link leftovers} lists, then mark
   * the run cleaned; throws naming what could not be removed.
   */
  cleanUp: (project: string, runId: string) => Promise<OrchestrationRun>;
  /**
   * One control call from a lead, already authenticated: `runId` is the run
   * its token belongs to.
   */
  control: (
    runId: string,
    call: ControlCall,
    requestId: string,
  ) => Promise<unknown>;
}

/**
 * What Jev (W3) hands `main/index.ts`, and the run engine (W1) calls.
 *
 * `ask` is the one way main asks Jev anything: it applies the point's mode
 * and threshold, and writes the log entry. `settle` records what was done in
 * the end, so shadow mode can be compared with the lead.
 */
export interface JevMainHandlers {
  get: () => Promise<JevState>;
  set: (config: JevConfig) => Promise<JevState>;
  setKey: (key: string | null) => Promise<JevState>;
  ask: (request: JudgeRequest) => Promise<JudgeResult>;
  log: () => Promise<JudgeLogEntry[]>;
  settle: (logId: string, outcome: string) => Promise<void>;
}

/**
 * What the team lead store hands `main/index.ts` (FE-88).
 *
 * Arguments reach these already checked: a saved lead went through
 * {@link parseTeamLead} as `personal`, an id through {@link leadId}.
 *
 * NOTE: A personal lead may reuse a built-in id to override it;
 * `removePersonal` refuses an id that is not personal, `setDefault` an id no
 * source holds. `list` answers with
 * only the built-in and personal leads for a null or unknown `project`
 * (Settings has none). The store, not the page, sends
 * {@link leadsChannels.changed}.
 */
export interface LeadsMainHandlers {
  list: (project: string | null) => Promise<LeadsList>;
  savePersonal: (project: string, lead: TeamLead) => Promise<LeadsList>;
  removePersonal: (project: string, id: string) => Promise<LeadsList>;
  setDefault: (project: string, id: string | null) => Promise<LeadsList>;
  pickContext: (project: string) => Promise<ContextPick>;
  inspectContext: (project: string, paths: string[]) => Promise<ContextEntry[]>;
}

/** The loopback control server, as main starts and stops it. */
export interface ControlServer {
  /** `127.0.0.1:<port>`, once listening. */
  endpoint: () => string | null;
  close: () => Promise<void>;
}

/**
 * Start the control server on loopback, routing each authenticated call to
 * `control`. W1 provides it.
 */
export type StartControlServer = (
  control: OrchestrationMainHandlers["control"],
) => Promise<ControlServer>;
