// The offline Lanework MCP server: MCP over stdio, newline-delimited JSON-RPC
// 2.0, serving the board tools against the local SQLite board.
//
// - Hand-rolled: `@modelcontextprotocol/sdk` and zod are not dependencies of
//   the desktop app, and this entry runs under the app's own Node
//   (`ELECTRON_RUN_AS_NODE=1`) and the plugin's `lanework mcp`, where nothing
//   can be installed. A tools-only server needs little: `initialize`,
//   `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
// - A tool that fails answers `isError: true` with the reason, never a crash
//   and never a JSON-RPC error: an agent reads the text and corrects its call.
//   Only a malformed request (unknown method, unknown tool) is a protocol
//   error.
//
// NOTE: stdout is the protocol channel. Nothing else may be written to it;
// logs go to stderr.
import { hostname } from "node:os";
import { BOARD_INSTRUCTIONS, toolInputSchema } from "@lanework/contracts";
import {
  type LocalStore,
  LocalStoreError,
  type OpenOptions,
  openLocalStore,
} from "../local-store/index";
import { checkShape, InvalidParams } from "./schema";
import { TOOLS, type ToolContext } from "./tools";

export const SERVER_NAME = "lanework";
const SERVER_VERSION = "0.1.0";
/** What we answer when a client asks for a version we do not know. */
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

/**
 * The board rules, word for word as the cloud server sends them: one text in
 * @lanework/contracts, so the two servers cannot drift. The parity check
 * holds this server to it.
 */
const INSTRUCTIONS = BOARD_INSTRUCTIONS;

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

/** `claude-code`, `codex`, … — the slug a checkpoint is signed with. */
function agentSlug(clientName: unknown): string {
  const name = typeof clientName === "string" ? clientName.toLowerCase() : "";
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude-code";
  const slug = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "agent";
}

function toolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.name === "delete_review",
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

/**
 * One server session: the store connection it writes through, and what the
 * client said about itself. Transport-free, so a test can drive it directly.
 */
export class LocalMcpSession {
  readonly store: LocalStore;
  #agent = "agent";
  readonly #host = hostname();

  constructor(store: LocalStore) {
    this.store = store;
  }

  /**
   * The answer to one message, or null for a notification.
   *
   * NOTE: The board tools answer at once. A tool whose `run` returns a
   * promise answers later; such a reply may overtake an earlier one, which
   * JSON-RPC allows (ids pair them). None does since `search_sessions` moved
   * to lanework-kit (FE-152); the path stays for one that reads the disk.
   */
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
    if (isNotification) return null; // initialized, cancelled, …: nothing to say.
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
        const client = args.clientInfo as { name?: unknown } | undefined;
        this.#agent = agentSlug(client?.name);
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
        return this.#call(args);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
    }
  }

  #call(params: Record<string, unknown>) {
    const tool = TOOLS.find((entry) => entry.name === params.name);
    if (!tool)
      throw new RpcError(INVALID_PARAMS, `unknown tool ${String(params.name)}`);
    const ctx: ToolContext = {
      store: this.store,
      agent: this.#agent,
      host: this.#host,
    };
    const failed = (error: unknown) => {
      if (error instanceof LocalStoreError)
        return text({ error: error.code, message: error.message }, true);
      if (error instanceof InvalidParams)
        return text({ error: "invalid", message: error.message }, true);
      // A SQLite error (busy past the timeout, disk full): still an answer.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`lanework mcp: ${tool.name} failed: ${message}\n`);
      return text({ error: "internal", message }, true);
    };
    try {
      const result: unknown = tool.run(checkShape(tool, params.arguments), ctx);
      if (result instanceof Promise)
        return result.then((value) => text(value), failed);
      return text(result);
    } catch (error) {
      return failed(error);
    }
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The lines to write back for one line of input; none for a notification.
 * A promise when one of its messages is answered later (see `handle`).
 */
export function handleLine(
  session: LocalMcpSession,
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

interface RunOptions extends OpenOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Serve MCP on stdio until stdin closes. Opens the local board at `path`
 * (default `~/.lanew/data.sqlite`, following `LANEWORK_HOME`).
 */
export function runLocalMcpServer(options: RunOptions = {}): Promise<void> {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return new Promise((resolve) => {
    // Inside the executor: a file that cannot be opened rejects, never throws.
    const store = openLocalStore({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    const session = new LocalMcpSession(store);
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
        `lanework mcp: ${error instanceof Error ? error.stack : String(error)}\n`,
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
        store.close();
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
