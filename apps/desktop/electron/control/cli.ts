// `lanework-control`: the lead agent's handle on its orchestration run
// (FE-87). The lead (Claude Code or Codex) runs it from its shell; it sends
// one JSON line to the app's loopback control server and prints the one line
// it gets back.
//
//   lanework-control ACTION [--json JSON | --input FILE|-] [--request-id ID]
//
// - Output is always exactly one JSON line on stdout, `{"ok":true,...}` or
//   `{"ok":false,"error":...}`, and the exit code is 0 only when `ok` is
//   true. `--help` is the one exception: it prints the usage text.
// - The input is checked here with the contract's own validator before
//   anything is sent, so a typo fails fast and never reaches the run.
// - Every call carries a request id. When the outcome is unknown (the line
//   was sent but no answer came back), the error names that id so the lead
//   retries the SAME call instead of queueing a second worker.
//
// NOTE: Bundled to `dist/electron/control/lanework-control.cjs` and run by
// the app's own Node (`ELECTRON_RUN_AS_NODE=1`) through the shim
// `install.ts` writes to `~/.lanew/bin/lanework-control`. No Electron, no
// main-process module: only Node and the shared contract.
import { randomUUID } from "node:crypto";
import { openSync, readSync } from "node:fs";
import { connect, isIP } from "node:net";
import {
  CONTROL_ACTIONS,
  CONTROL_ENV,
  CONTROL_INPUT_MAX,
  CONTROL_RESPONSE_MAX,
  type ControlAction,
  ControlInputError,
  type ControlResponse,
  controlFields,
  isControlAction,
  parseControlInput,
  REQUEST_ID_MAX,
  REQUEST_ID_PATTERN,
  WAIT_MAX_SECONDS,
} from "../../shared/orchestration";

/** Set by the shim to its own path, so `--help` names a runnable command. */
export const CONTROL_SELF_ENV = "LANEWORK_CONTROL_SELF";

const CONNECT_TIMEOUT_MS = 3_000;
/** Longer than the longest `wait`, so a full wait is never cut short. */
const REPLY_TIMEOUT_MS = (WAIT_MAX_SECONDS + 15) * 1_000;

/** One line per action: the JSON it takes, then what it does. */
const ACTION_HELP: Record<ControlAction, string> = {
  list: `  list      {}
            The run, every task with its status and latest result, and the
            agent/model ids delegate may name (run.choices).`,
  delegate: `  delegate  {"title":"Short title","prompt":"Self-contained instructions",
             "files":["src/feature"],"agent":"claude"|"codex",
             "model":"<id from list>","effort":"low|medium|high|xhigh|max",
             "dependsOn":["<taskId>"]}
            Queue a worker and return its taskId. "files" is its write scope:
            project-relative paths, where a directory covers what is under it
            and ["."] claims the whole checkout. "agent", "model", "effort"
            and "dependsOn" are optional. With no "model", Jev picks a tier
            (light, standard, heavy) when it is on and sure, otherwise the
            standard tier runs it. "dependsOn" holds taskIds that must be
            reviewed (accepted) before this one starts. A scope beyond what
            the user approved, or naming agent config (.claude, .codex,
            .mcp.json, .vscode, .husky, .lanework), waits for the user to
            allow it on the run's panel: the task shows "scopeApproval".`,
  get: `  get       {"taskId":"..."}
            One task, with its latest result. A tool approval it waits on
            shows in "needsInput" with the tool's "input" (the command, path
            or URL, secrets redacted): decide on that, not on "summary".`,
  wait: `  wait      {"timeoutSeconds":20}
            Block until a task changes, or until the timeout (0-${WAIT_MAX_SECONDS}).
            "changed" lists the taskIds that moved; it is empty on a timeout
            or when nothing is left running or queued.`,
  respond: `  respond   {"taskId":"...","requestId":"...","decision":"allow"|"deny"}
            Allow or deny the tool a worker is waiting on. Workers never
            prompt the user: list, get and wait show the request as that
            task's "needsInput", and it stays stopped until you decide.`,
  answer: `  answer    {"taskId":"...","requestId":"...","answers":{"<question text>":"<answer>"}}
            Answer the question a worker asked (its text and options come
            from needsInput), or pass "skip":true instead of "answers".`,
  steer: `  steer     {"taskId":"...","text":"..."}
            Redirect a worker that is still running, without discarding what
            it has done. Use it the moment one drifts; message only lands
            once it has stopped.`,
  message: `  message   {"taskId":"...","text":"..."}
            Give a stopped worker another turn in its own scope; it keeps its
            session, worktree and history.`,
  retry: `  retry     {"taskId":"...","text":"...","files":["src/feature"]}
            Retry a stopped worker with corrected write scopes. Use it only
            when the extra files are really needed. Scopes beyond what the
            user approved wait for them, as with delegate.`,
  cancel: `  cancel    {"taskId":"..."}
            Cancel a task, running or still queued.`,
  review: `  review    {"taskId":"..."}
            Accept a completed task's result.`,
  finish: `  finish    {}
            End the run, once every task is accepted or cancelled.`,
};

/** The usage text, naming `exe` as the command to run. */
export function controlHelp(exe = "lanework-control"): string {
  return `Lanework control: supervise this orchestration run from the lead agent.

Usage: ${exe} ACTION [--json JSON | --input FILE|-] [--request-id ID]

Actions, with the JSON object each one takes:
${CONTROL_ACTIONS.map((action) => ACTION_HELP[action]).join("\n")}

Usual loop: list -> delegate ... -> wait or get -> steer a worker that drifts,
unblock one with respond or answer -> inspect its changes yourself -> message
for corrections -> review each task -> finish.

When the run is paused, list, get and wait still return the reason and what
to do next. Do not keep polling or retrying mutations: explain the pause and
ask the user to click Resume in Lanework. Resume continues interrupted
workers in their kept worktrees. A blocked worker (a write outside its scope)
stays stopped until message, retry or cancel resolves it.

Output is one JSON line: {"ok":true,"result":...} or {"ok":false,"error":"..."}.
The exit code is 0 only when "ok" is true.

Input must be a JSON object; unknown fields are refused, never ignored.
--json takes it inline, --input FILE reads a file, --input - reads stdin.
Input is at most ${CONTROL_INPUT_MAX / 1024} KiB.

Every call carries a request id, and the run applies each id at most once.
When the outcome is unknown (a timeout, a dropped connection) the error
carries "requestId" and "retryWith": retry that exact call with
--request-id ID. Retrying a delegate under a fresh id would queue a second
worker.

Workers run inside the Lanework app, not in this process. Exiting this
command, or a failure here, never cancels a task the run already took.

Lanework sets ${CONTROL_ENV.endpoint} and ${CONTROL_ENV.token}
for the lead agent's process only. They are already in your environment;
never print them.
`;
}

type Output = Record<string, unknown> & { ok: boolean };

type Parsed =
  | { kind: "help" }
  | {
      kind: "call";
      action: ControlAction;
      input: Record<string, unknown>;
      requestId: string;
    };

/** A refusal before anything was sent: retrying the same call cannot help. */
class UsageError extends Error {}

/** Read all of `fd`, refusing more than {@link CONTROL_INPUT_MAX} bytes. */
function readCapped(fd: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      // A non-blocking stdin with nothing buffered yet: try again.
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      if ((error as NodeJS.ErrnoException).code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    total += read;
    if (total > CONTROL_INPUT_MAX)
      throw new UsageError(`Input exceeds ${CONTROL_INPUT_MAX / 1024} KiB`);
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readInput(flag: string, value: string): string {
  if (flag === "--json") {
    if (Buffer.byteLength(value) > CONTROL_INPUT_MAX)
      throw new UsageError(`Input exceeds ${CONTROL_INPUT_MAX / 1024} KiB`);
    return value;
  }
  if (value === "-") return readCapped(0);
  let fd: number;
  try {
    fd = openSync(value, "r");
  } catch (error) {
    throw new UsageError(`Cannot read ${value}: ${(error as Error).message}`);
  }
  return readCapped(fd);
}

/**
 * Parse the arguments, then check the input against the contract.
 *
 * @throws {UsageError} On anything that should not be sent.
 */
export function parseArgs(args: readonly string[]): Parsed {
  const isHelp = (value: string) =>
    value === "help" || value === "--help" || value === "-h";
  const [first, ...rest] = args;
  if (first === undefined || isHelp(first)) return { kind: "help" };
  if (!isControlAction(first))
    throw new UsageError(
      `Unknown action: ${first}. Use one of: ${CONTROL_ACTIONS.join(", ")}. Run lanework-control --help.`,
    );
  const action = first;
  let raw: string | null = null;
  let requestId: string | null = null;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] as string;
    // `lanework-control delegate --help` should explain, not fail.
    if (isHelp(flag)) return { kind: "help" };
    if (!flag.startsWith("--"))
      throw new UsageError(
        `Unexpected argument: ${flag}. Pass the JSON object as --json '<JSON>'.`,
      );
    const value = rest[index + 1];
    if (value === undefined)
      throw new UsageError(
        `Missing value for ${flag}. Run lanework-control --help for the argument list.`,
      );
    if (flag === "--request-id") {
      if (requestId !== null)
        throw new UsageError("Supply --request-id only once");
      requestId = value;
    } else if (flag === "--json" || flag === "--input") {
      if (raw !== null) throw new UsageError("Supply only one input");
      raw = readInput(flag, value);
    } else
      throw new UsageError(
        `Unknown option: ${flag}. Supported: --json, --input, --request-id.`,
      );
  }
  if (requestId !== null && !REQUEST_ID_PATTERN.test(requestId))
    throw new UsageError(
      `--request-id must be 1-${REQUEST_ID_MAX} letters, digits, ".", ":", - or _`,
    );
  let input: unknown = {};
  if (raw !== null) {
    try {
      input = JSON.parse(raw);
    } catch (error) {
      throw new UsageError(
        `Invalid JSON: ${(error as Error).message}. Pass one JSON object, e.g. --json '{"taskId":"..."}'.`,
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new UsageError("Input must be a JSON object");
  }
  try {
    parseControlInput(action, input);
  } catch (error) {
    if (error instanceof ControlInputError) {
      // The contract's message already lists the fields for an unknown one.
      const fields = controlFields(action);
      const hint = error.message.includes("Allowed:")
        ? ""
        : ` ${action} takes ${fields.length ? fields.join(", ") : "no fields"}.`;
      throw new UsageError(
        `${error.message}.${hint} Run lanework-control --help.`,
      );
    }
    throw error;
  }
  // NOTE: The input goes as the lead wrote it, not as parsed here. The server
  // runs the same parser, and sending the original keeps the two from
  // disagreeing about what was asked.
  return {
    kind: "call",
    action,
    input: input as Record<string, unknown>,
    requestId: requestId ?? randomUUID(),
  };
}

/** A failure talking to the server; `sent` when the run may have applied it. */
class SendError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}

/** `127.0.0.1:<port>` (or `localhost`, `[::1]`) as host and port. */
function loopbackAddress(endpoint: string): { host: string; port: number } {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(endpoint.trim());
  if (!match) throw new SendError("Invalid Lanework control endpoint", false);
  const host = match[1] as string;
  const port = Number(match[2]);
  if (!port || port > 65535)
    throw new SendError("Invalid Lanework control endpoint", false);
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback)
    throw new SendError("Lanework control only connects to localhost", false);
  return { host, port };
}

/** Send one request line and read one response line. */
function send(
  endpoint: string,
  token: string,
  call: { action: ControlAction; input: unknown; requestId: string },
): Promise<unknown> {
  const { host, port } = loopbackAddress(endpoint);
  const line = `${JSON.stringify({
    token,
    action: call.action,
    input: call.input,
    requestId: call.requestId,
  })}\n`;
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let sent = false;
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error: SendError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(replyTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const connectTimer = setTimeout(
      () =>
        finish(
          new SendError(
            `Cannot connect to Lanework at ${endpoint}: timed out. The app may have restarted, or this agent's sandbox may be blocking localhost.`,
            false,
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
    let replyTimer: NodeJS.Timeout | undefined;
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      sent = true;
      socket.write(line);
      replyTimer = setTimeout(
        () => finish(new SendError("No reply from Lanework: timed out", true)),
        REPLY_TIMEOUT_MS,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > CONTROL_RESPONSE_MAX) {
        finish(new SendError("Lanework's response is too large", true));
        return;
      }
      chunks.push(part);
      if (newline !== -1) parseReply();
    });
    const parseReply = () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        finish(
          new SendError(
            sent
              ? "No reply from Lanework: the connection closed"
              : "Lanework closed the connection",
            sent,
          ),
        );
        return;
      }
      try {
        finish(null, JSON.parse(text));
      } catch {
        finish(new SendError("Lanework returned an invalid response", true));
      }
    };
    socket.on("end", parseReply);
    socket.on("close", parseReply);
    socket.on("error", (error) =>
      finish(
        new SendError(
          sent
            ? `No reply from Lanework: ${error.message}`
            : `Cannot connect to Lanework at ${endpoint}: ${error.message}. The app may have restarted, or this agent's sandbox may be blocking localhost.`,
          sent,
        ),
      ),
    );
  });
}

const isResponse = (value: unknown): value is ControlResponse =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as { ok?: unknown }).ok === "boolean";

/** Name the id to retry with, unless the server said retrying cannot help. */
function withRetryHint(output: Output, requestId: string): Output {
  if (output.retryable === false) return output;
  return {
    ...output,
    requestId: output.requestId ?? requestId,
    retryWith: output.retryWith ?? `--request-id ${requestId}`,
  };
}

/**
 * Run the CLI.
 *
 * @returns The exit code: 0 only when the printed line has `"ok":true`.
 */
export async function runControlCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const emit = (output: Output): number => {
    print(JSON.stringify(output));
    return output.ok ? 0 : 1;
  };
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return emit({
      ok: false,
      error: (error as Error).message,
      retryable: false,
    });
  }
  if (parsed.kind === "help") {
    print(controlHelp(env[CONTROL_SELF_ENV] || "lanework-control").trimEnd());
    return 0;
  }
  const endpoint = env[CONTROL_ENV.endpoint];
  const token = env[CONTROL_ENV.token];
  if (!endpoint)
    return emit({
      ok: false,
      error:
        "No Lanework control connection. Only the lead of an approved orchestration run can use this; approve the plan in Lanework first.",
      retryable: false,
    });
  if (!token)
    return emit({
      ok: false,
      error:
        "No Lanework control credential. Start the lead conversation from Lanework.",
      retryable: false,
    });
  let reply: unknown;
  try {
    reply = await send(endpoint, token, parsed);
  } catch (error) {
    const failure =
      error instanceof SendError
        ? error
        : new SendError((error as Error).message, true);
    // NOTE: Once the line is on the wire the run may have applied it even
    // though its answer was lost. Hand back the id so a retry cannot
    // duplicate it.
    return emit(
      failure.sent
        ? withRetryHint({ ok: false, error: failure.message }, parsed.requestId)
        : { ok: false, error: failure.message },
    );
  }
  if (!isResponse(reply))
    return emit(
      withRetryHint(
        { ok: false, error: "Lanework returned an invalid response" },
        parsed.requestId,
      ),
    );
  if (reply.ok) return emit(reply as Output);
  return emit(withRetryHint(reply as Output, parsed.requestId));
}
