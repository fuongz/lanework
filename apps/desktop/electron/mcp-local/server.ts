// The offline Lanework MCP server (FE-52/W3): MCP over stdio, newline-delimited
// JSON-RPC 2.0, serving the board tools against the local SQLite board.
//
// ⚠️ Hand-rolled on purpose: `@modelcontextprotocol/sdk` and zod are not
// dependencies of the desktop app, and this entry runs under the app's own Node
// (`ELECTRON_RUN_AS_NODE=1`) and the plugin's `lanework mcp`, where nothing can
// be installed. The protocol surface a tools-only server needs is small:
// `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
//
// ⚠️ stdout is the protocol channel. Nothing else may ever be written to it —
// logs go to stderr.
//
// ⚠️ A tool that fails answers `isError: true` with the reason, never a crash
// and never a JSON-RPC error: an agent reads the text and corrects its call.
// Only a malformed request (unknown method, unknown tool) is a protocol error.
import { hostname } from "node:os";
import {
  type LocalStore,
  LocalStoreError,
  type OpenOptions,
  openLocalStore,
} from "../local-store/index";
import { checkShape, InvalidParams, shapeSchema } from "./schema";
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

/** The cloud server's instructions, minus everything about accounts and other people. */
const INSTRUCTIONS = [
  "lanework is a Kanban board for AI-driven development. A card is a review checklist: decisions to approve, then verify steps to prove. This server is the OFFLINE board: it lives in a SQLite file on this machine, has no accounts, and the Lanework app shows what you write here.",
  "Every tool needs a board_id and there is no default. To find it, run `git remote get-url origin` and call list_boards({ repo }) with the output as is. Exactly one board: use it. None: call list_boards without repo and ask the user which board this repo belongs to — the boards you can see, PLUS an option to create a new board for this repo (suggest `owner/name` from the remote as its name). Then link_repo the one they picked, or create_board if they chose a new one; never create a board they did not ask for. A board links to ONE repo: linking a board that already has another repo MOVES it (replace), it never adds a second. Several: ask the user. No git remote: ask the user. Never pick a board by its name.",
  "Before creating a card, read board_summary so its category and tags match the vocabulary the board already uses; the category is also what mints the card's permanent task id. After create_review, offer to review the new card right here.",
  "While working a card, call checkpoint after each checklist item you finish and before you stop mid-task. Asked to resume a card: get_review it and read its checkpoint. If checkpoint.git.wipRef is set AND you are not in the checkout it came from (checkpoint.host is another machine, or this is a fresh clone), check out checkpoint.git.head, then `git fetch origin <wipRef> && git cherry-pick --no-commit FETCH_HEAD && git reset` to restore the uncommitted work; in the same checkout that work is already on disk, so skip it. Re-run every check it claims passed, then continue from nextStep (or the summary).",
  "A card with streams comes back from get_review with `dispatch: { waves, briefs }`, and you are its lead. Run it wave by wave: spawn every stream of a wave at once, one sub-agent per stream, each in its own git worktree from the current HEAD (in the shared checkout when its isolation is shared), and hand each one `dispatch.briefs[key]` verbatim. No sub-agents? Run the streams yourself, one by one, in wave order. Sub-agents never call Lanework and never commit. After each wave, merge each worktree into the main checkout, revert anything outside the stream's `owns`, re-run the stream's checks, tick its verify items, and call checkpoint once for the wave. After the last wave, run the untagged verify items. On resume, re-dispatch only the streams whose verify items are not all ticked. A card without streams (dispatch: null) works as before: one agent, end to end.",
  "To review a card with the user in the CLI: get_review it, then ask the user with your option picker (AskUserQuestion) if you have one. Each pick-ONE group (boxes sharing a `group`) is one single-select question, its options the group's boxes, the one marked (Recommended) first. Gather the ungrouped decisions into multi-select questions of up to 4 boxes each. At most 4 questions per turn — ask again for the rest. A group with more than 4 options cannot fit: say so and send the user to the app for that group. Then call review_card ONCE with exactly what the user picked: a picked box checked: true, an offered but unpicked ungrouped box checked: false, and anything they typed under Other as that box's note. Never tick a decision the user did not pick; only a plain instruction in chat (e.g. 'tick the recommended ones') stands in for the picker. review_card does not move the card, and work starts only once it answers ready: true.",
].join("\n\n");

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
    inputSchema: shapeSchema(tool),
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

  /** The answer to one message, or null for a notification. */
  handle(message: unknown): JsonRpcResponse | null {
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
      return { jsonrpc: "2.0", id, result: this.#dispatch(method, params) };
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
    try {
      return text(tool.run(checkShape(tool, params.arguments), ctx));
    } catch (error) {
      if (error instanceof LocalStoreError)
        return text({ error: error.code, message: error.message }, true);
      if (error instanceof InvalidParams)
        return text({ error: "invalid", message: error.message }, true);
      // A SQLite error (busy past the timeout, disk full): still an answer.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`lanework mcp: ${tool.name} failed: ${message}\n`);
      return text({ error: "internal", message }, true);
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

/** One line of input → the line(s) to write back (none for a notification). */
export function handleLine(session: LocalMcpSession, line: string): string[] {
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
    const answers = parsed
      .map((message) => session.handle(message))
      .filter((answer): answer is JsonRpcResponse => answer !== null);
    return answers.length > 0 ? [JSON.stringify(answers)] : [];
  }
  const answer = session.handle(parsed);
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
    const respond = (line: string) => {
      try {
        for (const out of handleLine(session, line)) output.write(`${out}\n`);
      } catch (error) {
        process.stderr.write(
          `lanework mcp: ${error instanceof Error ? error.stack : String(error)}\n`,
        );
      }
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      flush(true);
      store.close();
      resolve();
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
