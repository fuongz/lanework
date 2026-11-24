// The lanework-control MCP server (FE-155): MCP over stdio, newline-delimited
// JSON-RPC 2.0, serving one tool per `lanework-control` action
// (`CONTROL_TOOLS` in `@lanework/contracts`), so an agent the app started can
// drive its sessions, memory and orchestration run without a shell.
//
// - Who may call what comes from this process's env, set by the app on the
//   conversation it started: `LANEWORK_SESSIONS_TOKEN` (`SESSIONS_ENV.token`)
//   serves the conductor tools and the `any` ones; `LANEWORK_CONTROL_TOKEN`
//   (`CONTROL_ENV.token`) the lead's run tools. Neither: no tools at all.
// - A call is checked against the contract's shape (`checkShape`, as
//   lanework-kit does), then sent through `../control/client.ts` exactly as
//   the CLI sends it: sessions actions with the sessions token, run actions
//   with the control token. The app's parsers stay the judge.
// - Hand-rolled like `../mcp-kit/server.ts`: no SDK or zod at run time.
// - A refused or failed call answers `isError: true` with the server's
//   message, never a JSON-RPC error; only an unknown method or tool is one.
//
// NOTE: stdout is the protocol channel. Nothing else may be written to it;
// logs go to stderr. No Electron here: it runs as `ELECTRON_RUN_AS_NODE=1`.
import { randomUUID } from "node:crypto";
import {
  type ControlToolContract,
  controlTool,
  controlToolsFor,
  toolInputSchema,
} from "@lanework/contracts";
import { isSessionAction, SESSIONS_ENV } from "../../shared/conductor-sessions";
import { CONTROL_ENV } from "../../shared/orchestration";
import { type ControlCall, requestControl } from "../control/client";
import { checkShape, InvalidParams } from "../mcp-local/schema";

export const SERVER_NAME = "lanework-control";
const SERVER_VERSION = "0.1.0";
/** What we answer when a client asks for a version we do not know. */
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

// Literals: they sit in the agent's cached prompt prefix.
const INSTRUCTIONS_CONDUCTOR =
  "lanework-control reaches the Lanework app that started this conversation: sessions_* start and follow separate sessions of your own, memory_* keep what you know of this project across conversations, conductors_create saves a conductor. Lanework tells you when a session's turn ends; do not poll.";
const INSTRUCTIONS_LEAD =
  "lanework-control reaches the Lanework app that runs this orchestration: run_list, then run_delegate workers, then end your turn. Lanework sends you a turn when a task needs you; unblock it with run_respond or run_answer, steer or message it, run_review it, and run_finish once every task is reviewed or cancelled. Never loop on run_wait.";
const INSTRUCTIONS_BOTH =
  "lanework-control reaches the Lanework app that started this conversation: sessions_* start and follow separate sessions of your own, memory_* keep what you know of this project across conversations, conductors_create saves a conductor. As this run's lead: run_list, then run_delegate workers, then end your turn. Lanework sends you a turn when a task or session needs you; do not poll, and never loop on run_wait.";
const INSTRUCTIONS_ANY =
  "lanework-control reaches the Lanework app that started this conversation: conductors_create saves a conductor, models_list lists the models a task may name, thread_read reads back the turns a handoff left out.";
const INSTRUCTIONS_NONE =
  "lanework-control is unavailable here: only a conversation the Lanework app started has its credentials, so this server offers no tools.";

/** The env this server reads; the app sets it on the conversation. */
export interface ControlEnv {
  endpoint: string | null;
  sessionsToken: string | null;
  controlToken: string | null;
  /**
   * The app says this is a conductor's process (`LANEWORK_CONTROL_AS`). Every
   * conversation it starts holds a sessions token, so the token alone does
   * not.
   */
  conductor: boolean;
}

/** {@link ControlEnv} from `env`; an empty value counts as unset. */
export function controlEnvOf(env: NodeJS.ProcessEnv): ControlEnv {
  return {
    endpoint: env[CONTROL_ENV.endpoint] || null,
    sessionsToken: env[SESSIONS_ENV.token] || null,
    controlToken: env[CONTROL_ENV.token] || null,
    conductor: env.LANEWORK_CONTROL_AS === "conductor",
  };
}

/**
 * Which tools this process gets: none without a sessions or control token;
 * the conductor's only on a conductor's process or a lead's (a lead is a
 * conductor leading a run); the `any` ones (conductors_create, models_list)
 * on every conversation the app started.
 */
export function controlRolesOf(
  env: ControlEnv,
): { conductor: boolean; lead: boolean } | null {
  if (env.sessionsToken === null && env.controlToken === null) return null;
  const lead = env.controlToken !== null;
  return {
    conductor: env.sessionsToken !== null && (env.conductor || lead),
    lead,
  };
}

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function failure(message: string, extra: Record<string, unknown> = {}) {
  return text({ error: message, ...extra }, true);
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ControlSessionOptions {
  /** The env to read; `process.env` when unset. */
  env?: NodeJS.ProcessEnv;
  /** How a call reaches the app; `requestControl` when unset. */
  request?: typeof requestControl;
}

/** One server session. Transport-free, so a test can drive it directly. */
export class ControlMcpSession {
  readonly #env: ControlEnv;
  readonly #tools: ControlToolContract[];
  readonly #request: typeof requestControl;

  constructor(options: ControlSessionOptions = {}) {
    this.#env = controlEnvOf(options.env ?? process.env);
    const roles = controlRolesOf(this.#env);
    this.#tools = roles ? controlToolsFor(roles) : [];
    this.#request = options.request ?? requestControl;
  }

  #instructions(): string {
    const roles = controlRolesOf(this.#env);
    if (!roles) return INSTRUCTIONS_NONE;
    if (roles.conductor && roles.lead) return INSTRUCTIONS_BOTH;
    if (roles.lead) return INSTRUCTIONS_LEAD;
    if (roles.conductor) return INSTRUCTIONS_CONDUCTOR;
    return INSTRUCTIONS_ANY;
  }

  /** The answer to one message, or null for a notification. */
  handle(message: unknown): JsonRpcResponse | Promise<JsonRpcResponse> | null {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    )
      return this.#error(null, INVALID_REQUEST, "not a JSON-RPC request");
    const { id, method, params } = message as JsonRpcMessage;
    const isNotification = id === undefined;
    if (typeof method !== "string")
      return isNotification
        ? null
        : this.#error(id ?? null, INVALID_REQUEST, "missing method");
    // NOTE: `notifications/cancelled` is ignored: a line already sent to the
    // app cannot be taken back, and the call answers when the app does.
    if (isNotification) return null;
    try {
      const result = this.#dispatch(method, params);
      if (result instanceof Promise)
        return result.then((value) => ({ jsonrpc: "2.0", id, result: value }));
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (error instanceof RpcError)
        return this.#error(id, error.code, error.message);
      throw error;
    }
  }

  #error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  #dispatch(method: string, params: unknown): unknown {
    const args = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": {
        const asked =
          typeof args.protocolVersion === "string" ? args.protocolVersion : "";
        return {
          protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: this.#instructions(),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.#tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: toolInputSchema(tool),
            annotations: {
              readOnlyHint: tool.readOnly,
              destructiveHint: false,
              openWorldHint: false,
            },
          })),
        };
      case "tools/call":
        return this.#call(args);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
    }
  }

  #call(params: Record<string, unknown>): Promise<unknown> | unknown {
    const name = String(params.name);
    const tool = controlTool(name);
    // A tool this conversation was not given is as unknown as a typo.
    if (!tool || !this.#tools.includes(tool))
      throw new RpcError(INVALID_PARAMS, `unknown tool ${name}`);
    let input: Record<string, unknown>;
    try {
      input = checkShape(tool, params.arguments);
    } catch (error) {
      if (error instanceof InvalidParams) return failure(error.message);
      throw error;
    }
    // As the CLI picks it per action: a conversation's own actions carry the
    // sessions token, a run's the control token.
    const sessions = isSessionAction(tool.action);
    const token = sessions ? this.#env.sessionsToken : this.#env.controlToken;
    if (!this.#env.endpoint)
      return failure(
        "No Lanework control connection. Only a conversation the Lanework app started can use lanework-control.",
      );
    if (!token)
      return failure(
        sessions
          ? "No Lanework sessions credential. Start the conversation from Lanework."
          : "No Lanework control credential. Only the lead of an approved orchestration run can use this.",
      );
    const call: ControlCall = {
      action: tool.action,
      input,
      requestId: randomUUID(),
    };
    return this.#request(this.#env.endpoint, token, call).then(
      (output) => {
        if (output.ok) return text(output.result ?? null);
        const message =
          typeof output.error === "string" ? output.error : "Lanework refused";
        // NOTE: `requestControl` adds `retryWith` (the CLI's flag) only when
        // the run may have applied the call. A tool call has no request id
        // to pass back, so say what to do instead.
        if (output.retryWith === undefined) return failure(message);
        return failure(message, {
          outcome: "unknown",
          hint: "The app may have applied this call. Check the current state (run_list, run_get or sessions_list) before calling it again.",
        });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `lanework-control mcp: ${name} failed: ${message}\n`,
        );
        return failure(message);
      },
    );
  }
}

/**
 * The lines to write back for one line of input; none for a notification.
 * A promise when one of its messages is answered later.
 */
export function handleLine(
  session: ControlMcpSession,
  line: string,
): string[] | Promise<string[]> {
  if (!line.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "parse error" },
      }),
    ];
  }
  // A JSON-RPC batch (2024-11-05 clients may send one).
  if (Array.isArray(parsed)) {
    const pending = parsed.map((message) => session.handle(message));
    const lines = (all: (JsonRpcResponse | null)[]) => {
      const answers = all.filter(
        (answer): answer is JsonRpcResponse => answer !== null,
      );
      return answers.length > 0 ? [JSON.stringify(answers)] : [];
    };
    return pending.some((answer) => answer instanceof Promise)
      ? Promise.all(pending).then(lines)
      : lines(pending as (JsonRpcResponse | null)[]);
  }
  const answer = session.handle(parsed);
  if (answer instanceof Promise)
    return answer.then((value) => [JSON.stringify(value)]);
  return answer ? [JSON.stringify(answer)] : [];
}

interface RunOptions extends ControlSessionOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Serve lanework-control on stdio until stdin closes and every call answered. */
export function runControlMcpServer(options: RunOptions = {}): Promise<void> {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return new Promise((resolve) => {
    const session = new ControlMcpSession(options);
    let buffer = "";
    const flush = (final: boolean) => {
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        respond(line);
        index = buffer.indexOf("\n");
      }
      if (final && buffer.trim()) {
        respond(buffer);
        buffer = "";
      }
    };
    // Answers still being worked out; stdin closing waits for them.
    const inFlight = new Set<Promise<void>>();
    const report = (error: unknown) => {
      process.stderr.write(
        `lanework-control mcp: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
    };
    const write = (lines: string[]) => {
      for (const out of lines) output.write(`${out}\n`);
    };
    const respond = (line: string) => {
      try {
        const lines = handleLine(session, line);
        if (!(lines instanceof Promise)) return write(lines);
        const later = lines.then(write, report).finally(() => {
          inFlight.delete(later);
        });
        inFlight.add(later);
      } catch (error) {
        report(error);
      }
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      flush(true);
      void Promise.allSettled([...inFlight]).then(() => resolve());
    };
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      flush(false);
    });
    input.once("end", finish);
    input.once("close", finish);
  });
}
