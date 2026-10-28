// A conductor's own sessions: work it hands to a separate conversation the
// user keeps, instead of to a worker of an orchestration run.
//
// A conductor (FE-95) runs `lanework-control sessions.start …` from its
// shell. Main starts an ordinary conversation in the project's checkout, on
// the conductor's permission mode, and names it after the title; it shows in
// the Sessions rail like any other. Unless told otherwise, main tells the
// conductor once that session's turn ends, in a hidden turn of its own, so it
// reviews the result and reports back.
//
// Unlike `delegate`, nothing here is bound to a run: no write scopes, no
// worktree, no merge. A conductor may only list, read and follow up the
// sessions it started; the user's other conversations are not its to touch.
//
// NOTE: Shapes, limits and validators only. Imported by the CLI bundle and
// the renderer, so no Node or Electron.

import { EFFORTS, type Effort } from "./conversation";
import {
  ControlInputError,
  controlEffort,
  controlObject,
  controlRequestId,
  controlText,
  PROMPT_MAX,
} from "./orchestration";
import {
  AGENT_NAME_MAX,
  isAgentSessionId,
  type TerminalAgent,
} from "./terminal";

/** Every `sessions.*` action, in the order `--help` lists them. */
export const SESSION_ACTIONS = [
  "sessions.start",
  "sessions.list",
  "sessions.read",
  "sessions.send",
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

/** A board task id, as the checkpoint hook reads one: `FE-98`. */
const TASK_ID = /^[A-Z]{2,5}-\d{1,5}$/;

/** What each action takes. */
export interface SessionInputs {
  "sessions.start": {
    title: string;
    prompt: string;
    /** Absent: the conductor's own model. */
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
}

function fail(message: string): never {
  throw new ControlInputError(message);
}

function sessionId(value: unknown): string {
  if (!isAgentSessionId(value))
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
      if (input.model !== undefined) {
        if (
          typeof input.model !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.model)
        )
          fail("model must be a model id; leave it out for the conductor's");
        out.model = input.model;
      }
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
};

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
                  "model":"<model id>","effort":"${EFFORTS.join("|")}",
                  "taskId":"FE-98","notifyOnComplete":true}
            Conductors only. Start a separate session in this project's
            checkout and submit the prompt as its first turn. It runs on
            your permission mode and shows in the user's Sessions rail
            under the title. "model" and "effort" default to yours;
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
};
