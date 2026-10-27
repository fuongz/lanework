// The orchestration contract (FE-87): a lead conversation (Claude or Codex)
// spawns worker conversations on demand, and Jev, a cheap calibrated judge,
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
//   the conversation view, it names a workspace and ids, never a folder or a
//   command.
// - Main's own modules (the run engine and Jev), whose handler shapes are
//   fixed here so `main/index.ts` can register them before they exist.
//
// NOTE: No runtime logic lives here, only shapes, limits and validators. The
// file is imported by the preload and the renderer, so it must not import
// Node or Electron.

import { type ConversationAgent, EFFORTS, type Effort } from "./conversation";

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
/** What a model id may be: it becomes `--model` / `-m`'s value. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  /** The worker's conversation id, once it has started. */
  conversation: string | null;
  /** The worker's branch in its own worktree, once it has one. */
  branch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationRun {
  id: string;
  /** The workspace slug the run belongs to. */
  workspace: string;
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
  tasks: OrchestrationTask[];
  createdAt: number;
  updatedAt: number;
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
  workspace: string;
  lead: string;
  leadAgent: ConversationAgent;
  /** What the user asked for. */
  request: string;
  status: ProposalStatus;
  title: string;
  summary: string;
  maxWorkers: number;
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

function agent(value: unknown, label = "agent"): ConversationAgent {
  if (value !== "claude" && value !== "codex")
    fail(`${label} must be "claude" or "codex"`);
  return value;
}

function model(value: unknown, label = "model"): string {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value))
    fail(`${label} must be a model id from list`);
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
      if (input.model !== undefined) out.model = model(input.model);
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
    return {
      id: id(task.id, `${label}'s id`),
      title: text(task.title, `${label}'s title`, TITLE_MAX),
      prompt: text(task.prompt, `${label}'s prompt`, PROMPT_MAX),
      agent: task.agent == null ? null : agent(task.agent, `${label}'s agent`),
      model: task.model == null ? null : model(task.model, `${label}'s model`),
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
      "workspace",
      "lead",
      "leadAgent",
      "request",
      "status",
      "title",
      "summary",
      "maxWorkers",
      "tasks",
      "error",
    ],
    "The proposal",
  );
  if (input.version !== 1) fail("Unknown proposal version");
  if (input.status !== "ready") fail("Only a ready proposal can be approved");
  if (typeof input.workspace !== "string" || !input.workspace)
    fail("workspace must be a slug");
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
    workspace: input.workspace,
    lead: input.lead,
    leadAgent: agent(input.leadAgent, "leadAgent"),
    request: text(input.request, "request", PROMPT_MAX),
    status: "ready",
    title: text(input.title, "title", TITLE_MAX),
    summary: text(input.summary, "summary", 2000),
    maxWorkers: input.maxWorkers as number,
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

function tierModel(value: unknown, label: string): TierModel {
  const input = strictObject(value, ["agent", "model", "effort"], label);
  return {
    agent: agent(input.agent, `${label}'s agent`),
    model: model(input.model, `${label}'s model`),
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
  return trimmed.replace(/\/+$/, "");
}

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

// ─── IPC ────────────────────────────────────────────────────────────────────

export const orchestrationChannels = {
  /** The workspace's runs, newest first. */
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

/** Main → renderer, on {@link orchestrationChannels.changed}. */
export interface OrchestrationEvent {
  workspace: string;
  run: OrchestrationRun;
}

/**
 * The orchestration surface in the renderer.
 *
 * Every call names a workspace slug and ids main minted, never a folder.
 */
export interface DesktopOrchestrationApi {
  runs: (workspace: string) => Promise<OrchestrationRun[]>;
  run: (workspace: string, runId: string) => Promise<OrchestrationRun | null>;
  approve: (proposal: OrchestrationProposal) => Promise<OrchestrationRun>;
  pause: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  resume: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  stop: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  cancelTask: (
    workspace: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
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
  runs: (workspace: string) => Promise<OrchestrationRun[]>;
  run: (workspace: string, runId: string) => Promise<OrchestrationRun | null>;
  approve: (proposal: OrchestrationProposal) => Promise<OrchestrationRun>;
  pause: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  resume: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  stop: (workspace: string, runId: string) => Promise<OrchestrationRun>;
  cancelTask: (
    workspace: string,
    runId: string,
    taskId: string,
  ) => Promise<OrchestrationRun>;
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
