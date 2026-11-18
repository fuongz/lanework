// The lanework-kit MCP server (FE-152): MCP over stdio, newline-delimited
// JSON-RPC 2.0, serving the kit's 5 tools (`KIT_TOOLS` in
// `@lanework/protocol`) on the kit core (`../kit`).
//
// - Each call goes to the running app's kit socket first (its warm fff index
//   and natives), and runs here when no app answers (`./socket.ts`).
// - Scope: this process's cwd, the folder the agent runs in, and folders
//   under it that a call names; never wider. A cwd that is `/` or the home
//   folder searches nothing (the kit refuses it).
// - Hand-rolled like `../mcp-local/server.ts`, for the same reasons: no SDK
//   or zod at run time, and a tools-only server needs little.
// - A tool that fails answers `isError: true` with `{ error, message }`,
//   never a JSON-RPC error; only an unknown method or tool is one. Calls
//   answer when they finish, so a quick one may overtake a slow one (ids
//   pair them).
//
// NOTE: stdout is the protocol channel. Nothing else may be written to it;
// logs go to stderr. No Electron here: it runs as `ELECTRON_RUN_AS_NODE=1`.
import {
  KIT_TOOLS,
  type KitToolName,
  toolInputSchema,
} from "@lanework/protocol";
import {
  appNatives,
  isKitMethod,
  KIT_METHODS,
  type KitContext,
  KitError,
  type KitNatives,
  toKitError,
} from "../kit";
import { kitSocketPath } from "../main/kit-socket";
import { appHomeDir } from "../main/paths";
import { checkShape, InvalidParams } from "../mcp-local/schema";
import { KitSocketClient, NO_SOCKET } from "./socket";

export const SERVER_NAME = "lanework-kit";
const SERVER_VERSION = "0.1.0";
/** What we answer when a client asks for a version we do not know. */
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

/** A literal: it sits in the agent's cached prompt prefix. */
const INSTRUCTIONS =
  "lanework-kit searches this machine's files and agent conversations: find_files (fuzzy paths), search_text (ripgrep), search_structural (ast-grep patterns), list_files and search_sessions. Every tool runs in the folder you started in, or a folder under it that you pass as `folder`; paths in answers are relative to the folder searched.";

/**
 * Natives when this process runs a tool itself: fff and ast-grep through
 * the app's loaders (they resolve `dist/electron/node_modules` from this
 * bundle). The server lives for the agent's session, so fff's index is cold
 * once and warm after; without it `find_files` falls back to a ranking that
 * misses abbreviations (`convview`).
 */
const STANDALONE_NATIVES: KitNatives = appNatives;

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

function toolList() {
  return KIT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      openWorldHint: false,
    },
  }));
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** A core result in the answer shape the contract names (`KitToolOutputs`). */
function answerOf(name: KitToolName, result: unknown): unknown {
  switch (name) {
    case "find_files":
      return { files: result };
    case "search_text":
    case "search_structural":
      return { matches: result };
    case "list_files":
      return result;
    case "search_sessions":
      return { sessions: result };
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface KitSessionOptions {
  /** The agent's folder; `process.cwd()` when unset. */
  cwd?: string;
  /** The app's socket; `<app home>/run/kit.sock` when unset, null for none. */
  socket?: KitSocketClient | null;
  /** The natives a tool run here uses. */
  natives?: KitNatives;
}

/** One server session. Transport-free, so a test can drive it directly. */
export class KitMcpSession {
  readonly #cwd: string;
  readonly #socket: KitSocketClient | null;
  readonly #natives: KitNatives;
  /** Calls still running, by request id, for `notifications/cancelled`. */
  readonly #running = new Map<JsonRpcId, AbortController>();

  constructor(options: KitSessionOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd();
    this.#socket =
      options.socket === undefined
        ? new KitSocketClient(kitSocketPath(appHomeDir()))
        : options.socket;
    this.#natives = options.natives ?? STANDALONE_NATIVES;
  }

  /** Stop talking to the app. */
  close(): void {
    for (const controller of this.#running.values()) controller.abort();
    this.#socket?.close();
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
    if (isNotification) {
      if (method === "notifications/cancelled") {
        const asked = (params as { requestId?: JsonRpcId } | undefined)
          ?.requestId;
        if (asked !== undefined) this.#running.get(asked)?.abort();
      }
      return null;
    }
    try {
      const result = this.#dispatch(id, method, params);
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

  #dispatch(id: JsonRpcId, method: string, params: unknown): unknown {
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
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolList() };
      case "tools/call":
        return this.#call(id, args);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
    }
  }

  #call(id: JsonRpcId, params: Record<string, unknown>): Promise<unknown> {
    const tool = KIT_TOOLS.find((entry) => entry.name === params.name);
    if (!tool || !isKitMethod(tool.name))
      throw new RpcError(INVALID_PARAMS, `unknown tool ${String(params.name)}`);
    const name = tool.name;
    const controller = new AbortController();
    this.#running.set(id, controller);
    const run = async () => {
      const args = checkShape(tool, params.arguments);
      const answer = await this.#socket?.call(name, {
        ...args,
        cwd: this.#cwd,
        // Narrows the app's scope (the cwd's whole project) to the cwd.
        roots: [this.#cwd],
      });
      if (answer !== undefined && answer !== NO_SOCKET) return answer;
      const ctx: KitContext = {
        cwd: this.#cwd,
        roots: [this.#cwd],
        signal: controller.signal,
        natives: this.#natives,
      };
      return KIT_METHODS[name](args, ctx);
    };
    return run()
      .then(
        (result) => text(answerOf(name, result)),
        (error: unknown) => {
          const failure =
            error instanceof InvalidParams
              ? new KitError("invalid", error.message)
              : toKitError(error, controller.signal);
          if (failure.code === "internal")
            process.stderr.write(
              `lanework-kit mcp: ${name} failed: ${failure.message}\n`,
            );
          return text({ error: failure.code, message: failure.message }, true);
        },
      )
      .finally(() => this.#running.delete(id));
  }
}

/**
 * The lines to write back for one line of input; none for a notification.
 * A promise when one of its messages is answered later.
 */
export function handleLine(
  session: KitMcpSession,
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

interface RunOptions extends KitSessionOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Serve lanework-kit on stdio until stdin closes and every call answered. */
export function runKitMcpServer(options: RunOptions = {}): Promise<void> {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return new Promise((resolve) => {
    const session = new KitMcpSession(options);
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
        `lanework-kit mcp: ${error instanceof Error ? error.stack : String(error)}\n`,
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
      void Promise.allSettled([...inFlight]).then(() => {
        session.close();
        resolve();
      });
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
