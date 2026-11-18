// The lanework-control tools (FE-155): one MCP tool per action of the
// `lanework-control` CLI, so an agent can call the app's control server
// without a shell. A conversation's own actions (`sessions.*`, `memory.*`,
// `conductors.create`) are checked by `parseSessionRequest` in
// `apps/desktop/shared/conductor-sessions.ts`; a run's (`list`, `delegate`,
// …) by `parseControlRequest` in `apps/desktop/shared/orchestration.ts`.
// The input shapes here mirror those parsers; the parsers stay the judge.
//
// NOTE: This package may not import from `apps/`, so the limits and enums
// below are copies of the app's (see {@link CONTROL_TOOL_LIMITS}). When a
// parser changes shape or limit, change it here in the same commit.
// Descriptions are literals: they sit in an agent's cached prompt prefix.
import type { ToolContract, ToolParam } from "./schema";

/**
 * Who may call a tool.
 *
 * - `conductor`: only a conductor's own conversation (sessions, memory).
 * - `lead`: only the lead of an orchestration run.
 * - `any`: any conversation the app started.
 */
export type ControlToolRole = "conductor" | "lead" | "any";

export type ControlToolName =
  | "sessions_start"
  | "sessions_list"
  | "sessions_read"
  | "sessions_send"
  | "memory_read"
  | "memory_append"
  | "memory_write"
  | "conductors_create"
  | "models_list"
  | "run_list"
  | "run_delegate"
  | "run_get"
  | "run_wait"
  | "run_respond"
  | "run_answer"
  | "run_steer"
  | "run_message"
  | "run_retry"
  | "run_cancel"
  | "run_review"
  | "run_finish";

/** The wire action each tool sends, as the CLI's first argument names it. */
export type ControlToolAction =
  | "sessions.start"
  | "sessions.list"
  | "sessions.read"
  | "sessions.send"
  | "memory.read"
  | "memory.append"
  | "memory.write"
  | "conductors.create"
  | "models.list"
  | "list"
  | "delegate"
  | "get"
  | "wait"
  | "respond"
  | "answer"
  | "steer"
  | "message"
  | "retry"
  | "cancel"
  | "review"
  | "finish";

/** One lanework-control tool: the MCP contract plus where it goes. */
export interface ControlToolContract extends ToolContract<ControlToolName> {
  /** The action the control server receives. */
  action: ControlToolAction;
  role: ControlToolRole;
}

/**
 * The app's limits, as the parsers enforce them. Copies: the names are the
 * app's constants (`shared/orchestration.ts`, `shared/conductor-sessions.ts`,
 * `shared/terminal.ts`).
 */
export const CONTROL_TOOL_LIMITS = {
  TITLE_MAX: 160,
  PROMPT_MAX: 30_000,
  FILES_MAX: 64,
  WAIT_MAX_SECONDS: 25,
  AGENT_NAME_MAX: 120,
  READ_LIMIT_MAX: 5,
  READ_LIMIT_DEFAULT: 2,
  READ_CHARS_MIN: 200,
  READ_CHARS_MAX: 6000,
  READ_CHARS_DEFAULT: 1500,
  MEMORY_NOTES_MAX: 8000,
  LEAD_NAME_MAX: 60,
  LEAD_INSTRUCTIONS_MAX: 20_000,
  LEAD_CONTEXT_FILES_MAX: 20,
} as const;

const L = CONTROL_TOOL_LIMITS;

/** The app's `EFFORTS`. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** The app's `TERMINAL_AGENTS` and `WORKER_AGENTS`. */
const AGENTS = ["claude", "codex", "opencode"] as const;
/** The app's `LEAD_AGENTS`: OpenCode never leads. */
const LEAD_AGENTS = ["claude", "codex"] as const;
/** The app's `PERMISSIONS`. */
const PERMISSIONS = [
  "manual",
  "acceptEdits",
  "auto",
  "bypassPermissions",
] as const;
/** The app's `LEAD_ICONS`. */
const LEAD_ICONS = [
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

// ── Shared parameter shapes ─────────────────────────────────────────────────

const EFFORT: ToolParam = {
  type: "string",
  enum: EFFORTS,
  description: "Reasoning effort",
};

const NOTIFY: ToolParam = {
  type: "boolean",
  description:
    "Default true: Lanework tells you once the session's turn ends, so you review it",
};

const SESSION_ID: ToolParam = {
  type: "string",
  description: "A sessionId from sessions_list",
};

const TASK_ID: ToolParam = {
  type: "string",
  description: "A taskId from run_list: 1-64 letters, digits, - or _",
};

const REQUEST_ID: ToolParam = {
  type: "string",
  description: "The requestId of the task's needsInput",
};

const WORKER_TEXT: ToolParam = {
  type: "string",
  description: `Instructions for the worker, at most ${L.PROMPT_MAX} characters`,
};

const SCOPES: ToolParam = {
  type: "string[]",
  description: `The write scope: at most ${L.FILES_MAX} project-relative paths; a directory covers what is under it, ["."] the whole checkout, [] edits no file`,
};

// ── The tools ───────────────────────────────────────────────────────────────

/** Every lanework-control tool: a conversation's own first, then a run's. */
// NOTE: Built in a pure IIFE: its descriptions read the limits, which
// esbuild cannot prove side-effect free, so a bundle that imports the
// package for anything else (the checkpoint hook) would keep the whole list.
export const CONTROL_TOOLS: readonly ControlToolContract[] =
  /* @__PURE__ */ ((): ControlToolContract[] => [
    {
      name: "sessions_start",
      action: "sessions.start",
      role: "conductor",
      description:
        "Start a separate session in this project's checkout and submit the prompt as its first turn. It runs on your permission mode, under the title, and is yours alone: the user reaches it through you. agent defaults to yours; model and effort to yours on your agent, else that agent's default (OpenCode's model is provider/model). Unless notifyOnComplete is false, Lanework tells you once its turn ends: review it then and report to the user. Returns as soon as it started, with its sessionId. At most 4 of your sessions may work at once.",
      readOnly: false,
      properties: {
        title: {
          type: "string",
          description: `A short title, at most ${L.AGENT_NAME_MAX} characters`,
        },
        prompt: {
          type: "string",
          description: `Self-contained instructions, at most ${L.PROMPT_MAX} characters`,
        },
        agent: {
          type: "string",
          enum: AGENTS,
          description: "The CLI it runs on",
        },
        model: {
          type: "string",
          description: "A model id; provider/model when agent is opencode",
        },
        effort: EFFORT,
        taskId: {
          type: "string",
          description: 'The board card it works on, e.g. "FE-98"',
        },
        notifyOnComplete: NOTIFY,
      },
      required: ["title", "prompt"],
    },
    {
      name: "sessions_list",
      action: "sessions.list",
      role: "conductor",
      description:
        "The sessions you started, newest first, with their status: working, waiting (on the user), idle, failed or terminal.",
      readOnly: true,
      properties: {},
    },
    {
      name: "sessions_read",
      action: "sessions.read",
      role: "conductor",
      description:
        "The last exchanges of one of your sessions, prompts and replies only, each cut to maxChars.",
      readOnly: true,
      properties: {
        sessionId: SESSION_ID,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: L.READ_LIMIT_MAX,
          description: `Exchanges returned; default ${L.READ_LIMIT_DEFAULT}`,
        },
        maxChars: {
          type: "integer",
          minimum: L.READ_CHARS_MIN,
          maximum: L.READ_CHARS_MAX,
          description: `Each message cut to this; default ${L.READ_CHARS_DEFAULT}`,
        },
      },
      required: ["sessionId"],
    },
    {
      name: "sessions_send",
      action: "sessions.send",
      role: "conductor",
      description:
        "A follow-up to one of your sessions. Refused while it works or waits on the user. notifyOnComplete works as in sessions_start.",
      readOnly: false,
      properties: {
        sessionId: SESSION_ID,
        prompt: {
          type: "string",
          description: `The follow-up, at most ${L.PROMPT_MAX} characters`,
        },
        notifyOnComplete: NOTIFY,
      },
      required: ["sessionId", "prompt"],
    },
    {
      name: "memory_read",
      action: "memory.read",
      role: "conductor",
      description:
        "What you remember of this project across your conversations: your last 30 sessions with a summary each, the last 20 orchestration runs you led with each worker's outcome, and your notes. Read it before you plan.",
      readOnly: true,
      properties: {},
    },
    {
      name: "memory_append",
      action: "memory.append",
      role: "conductor",
      description:
        "Add one fact to your notes for this project, on a new line; the rest stays. Prefer it to memory_write for one new decision or fact. Refused when the notes would grow past 8000 characters: then rewrite them shorter with memory_write.",
      readOnly: false,
      properties: {
        text: {
          type: "string",
          description: "The fact to add, non-empty",
        },
      },
      required: ["text"],
    },
    {
      name: "memory_write",
      action: "memory.write",
      role: "conductor",
      description:
        'Replace your notes for this project, at most 8000 characters: send everything worth keeping, the old notes are gone. "" clears them. Use it only for a full rewrite; memory_append adds one fact. Lanework keeps the ledger.',
      readOnly: false,
      properties: {
        notes: {
          type: "string",
          description: `The whole notes, at most ${L.MEMORY_NOTES_MAX} characters`,
        },
      },
      required: ["notes"],
    },
    {
      name: "models_list",
      action: "models.list",
      role: "any",
      description:
        "The models a proposal's tasks may name, grouped by agent (OpenCode ids grouped by provider: the id is provider/model), and for a conductor how each model fared in its past runs. Call it before naming a model; or leave agent and model null for Lanework to pick by tier.",
      readOnly: true,
      properties: {
        agent: {
          type: "string",
          enum: AGENTS,
          description: "Only this agent's models",
        },
        query: {
          type: "string",
          description: "Only ids containing this text, e.g. sonnet or glm",
        },
      },
    },
    {
      name: "conductors_create",
      action: "conductors.create",
      role: "any",
      description:
        "Save a conductor of your own in this project, as the Conductors rail's dialog would, and return its id. Only name is required: agent, model and effort default to yours, instructions to the dialog's template, contextFiles to none, permission to the composer's default. Never replaces one: a taken id gets -2, -3. It does not start the conductor; the user opens it from the rail.",
      readOnly: false,
      properties: {
        name: {
          type: "string",
          description: `One line, at most ${L.LEAD_NAME_MAX} characters`,
        },
        instructions: {
          type: "string",
          description: `Its instructions, markdown, at most ${L.LEAD_INSTRUCTIONS_MAX} characters`,
        },
        icon: { type: "string", enum: LEAD_ICONS },
        agent: { type: "string", enum: LEAD_AGENTS },
        model: { type: "string", description: "A model id" },
        effort: EFFORT,
        contextFiles: {
          type: "string[]",
          description: `At most ${L.LEAD_CONTEXT_FILES_MAX} project-relative paths`,
        },
        permission: { type: "string", enum: PERMISSIONS },
      },
      required: ["name"],
    },
    {
      name: "run_list",
      action: "list",
      role: "lead",
      description:
        "The run, every task with its status and latest result, and the agent/model ids run_delegate may name (run.choices).",
      readOnly: true,
      properties: {},
    },
    {
      name: "run_delegate",
      action: "delegate",
      role: "lead",
      description:
        "Queue a worker and return its taskId. files is its write scope. With no model, Jev picks a tier when it is on and sure, otherwise the standard tier runs it. dependsOn holds taskIds that must be reviewed (accepted) before this one starts. A scope beyond what the user approved, or naming agent config (.claude, .codex, .mcp.json, .vscode, .husky, .lanework), waits for the user on the run's panel: the task shows scopeApproval.",
      readOnly: false,
      properties: {
        title: {
          type: "string",
          description: `A short title, at most ${L.TITLE_MAX} characters`,
        },
        prompt: {
          type: "string",
          description: `Self-contained instructions, at most ${L.PROMPT_MAX} characters`,
        },
        files: SCOPES,
        agent: { type: "string", enum: AGENTS },
        model: {
          type: "string",
          description: "A model id from run_list; provider/model for opencode",
        },
        effort: EFFORT,
        dependsOn: { type: "string[]", description: "taskIds" },
      },
      required: ["title", "prompt", "files"],
    },
    {
      name: "run_get",
      action: "get",
      role: "lead",
      description:
        "One task, with its latest result. A tool approval it waits on shows in needsInput with the tool's input (secrets redacted): decide on that, not on summary.",
      readOnly: true,
      properties: { taskId: TASK_ID },
      required: ["taskId"],
    },
    {
      name: "run_wait",
      action: "wait",
      role: "lead",
      description:
        "Block until a task changes, or until the timeout. changed lists the taskIds that moved; it is empty on a timeout or when nothing is left running or queued. For one short wait only: never loop on it; end your turn instead, and Lanework sends you a turn when a task needs you.",
      readOnly: true,
      properties: {
        timeoutSeconds: {
          type: "integer",
          minimum: 0,
          maximum: L.WAIT_MAX_SECONDS,
        },
      },
    },
    {
      name: "run_respond",
      action: "respond",
      role: "lead",
      description:
        "Allow or deny the tool a worker is waiting on (its needsInput). It stays stopped until you decide.",
      readOnly: false,
      properties: {
        taskId: TASK_ID,
        requestId: REQUEST_ID,
        decision: { type: "string", enum: ["allow", "deny"] },
      },
      required: ["taskId", "requestId", "decision"],
    },
    {
      name: "run_answer",
      action: "answer",
      role: "lead",
      description:
        "Answer the question a worker asked (its text and options come from needsInput), or skip it. Pass exactly one of answers and skip.",
      readOnly: false,
      properties: {
        taskId: TASK_ID,
        requestId: REQUEST_ID,
        answers: {
          type: "string-map",
          description: "1-8 entries: question text to answer, each a string",
        },
        skip: { type: "boolean", description: "true to skip the question" },
      },
      required: ["taskId", "requestId"],
    },
    {
      name: "run_steer",
      action: "steer",
      role: "lead",
      description:
        "Redirect a worker that is still running, without discarding what it has done. Use it the moment one drifts; run_message only lands once it has stopped.",
      readOnly: false,
      properties: { taskId: TASK_ID, text: WORKER_TEXT },
      required: ["taskId", "text"],
    },
    {
      name: "run_message",
      action: "message",
      role: "lead",
      description:
        "Give a stopped worker another turn in its own scope; it keeps its session, worktree and history.",
      readOnly: false,
      properties: { taskId: TASK_ID, text: WORKER_TEXT },
      required: ["taskId", "text"],
    },
    {
      name: "run_retry",
      action: "retry",
      role: "lead",
      description:
        "Retry a stopped worker with corrected write scopes. Use it only when the extra files are really needed. Scopes beyond what the user approved wait for them, as with run_delegate.",
      readOnly: false,
      properties: { taskId: TASK_ID, text: WORKER_TEXT, files: SCOPES },
      required: ["taskId", "text", "files"],
    },
    {
      name: "run_cancel",
      action: "cancel",
      role: "lead",
      description: "Cancel a task, running or still queued.",
      readOnly: false,
      properties: { taskId: TASK_ID },
      required: ["taskId"],
    },
    {
      name: "run_review",
      action: "review",
      role: "lead",
      description: "Accept a completed task's result.",
      readOnly: false,
      properties: { taskId: TASK_ID },
      required: ["taskId"],
    },
    {
      name: "run_finish",
      action: "finish",
      role: "lead",
      description: "End the run, once every task is accepted or cancelled.",
      readOnly: false,
      properties: {},
    },
  ])();

/**
 * The tools a conversation may call: `any` tools always, `conductor` tools
 * for a conductor's own conversation, `lead` tools for a run's lead. In
 * {@link CONTROL_TOOLS}'s order.
 */
export function controlToolsFor(roles: {
  conductor: boolean;
  lead: boolean;
}): ControlToolContract[] {
  return CONTROL_TOOLS.filter(
    (tool) =>
      tool.role === "any" ||
      (tool.role === "conductor" && roles.conductor) ||
      (tool.role === "lead" && roles.lead),
  );
}

/** One control tool by its MCP name; undefined when there is none. */
export function controlTool(name: string): ControlToolContract | undefined {
  return CONTROL_TOOLS.find((tool) => tool.name === name);
}
