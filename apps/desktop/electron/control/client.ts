// The network half of `lanework-control` (FE-87, FE-155): one JSON line to
// the app's loopback control server, `{ token, action, input, requestId }`,
// and the one line it answers. Shared by the CLI (`cli.ts`) and the
// lanework-control MCP server (`../mcp-control/server.ts`).
//
// - Loopback only: an endpoint that is not localhost is refused unsent.
// - Every failure says whether the line went out (`SendError.sent`). Once it
//   did, the run may have applied it though its answer was lost, so the
//   caller hands back the request id for a retry of the SAME call.
//
// NOTE: No Electron, no main-process module: only Node and the shared
// contract. It runs under `ELECTRON_RUN_AS_NODE=1`.
import { connect, isIP } from "node:net";
import type { SessionAction } from "../../shared/conductor-sessions";
import {
  CONTROL_RESPONSE_MAX,
  type ControlAction,
  type ControlResponse,
  WAIT_MAX_SECONDS,
} from "../../shared/orchestration";

const CONNECT_TIMEOUT_MS = 3_000;
/** Longer than the longest `wait`, so a full wait is never cut short. */
const REPLY_TIMEOUT_MS = (WAIT_MAX_SECONDS + 15) * 1_000;

/** One call to the control server. */
export interface ControlCall {
  action: ControlAction | SessionAction;
  input: unknown;
  requestId: string;
}

/** What a call ends in: the server's answer, or a failure shaped like one. */
export type ControlOutput = Record<string, unknown> & { ok: boolean };

/** A failure talking to the server; `sent` when the run may have applied it. */
export class SendError extends Error {
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
export function send(
  endpoint: string,
  token: string,
  call: ControlCall,
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
            : (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
              ? "Lanework app is not running. Open it and try again."
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
export function withRetryHint(
  output: ControlOutput,
  requestId: string,
): ControlOutput {
  if (output.retryable === false) return output;
  return {
    ...output,
    requestId: output.requestId ?? requestId,
    retryWith: output.retryWith ?? `--request-id ${requestId}`,
  };
}

/**
 * Send `call` and turn every outcome into one {@link ControlOutput}: the
 * server's answer as is when it succeeded, a failure with the id to retry
 * with (`requestId`, `retryWith`) whenever the run may have applied it.
 */
export async function requestControl(
  endpoint: string,
  token: string,
  call: ControlCall,
): Promise<ControlOutput> {
  let reply: unknown;
  try {
    reply = await send(endpoint, token, call);
  } catch (error) {
    const failure =
      error instanceof SendError
        ? error
        : new SendError((error as Error).message, true);
    // NOTE: Once the line is on the wire the run may have applied it even
    // though its answer was lost. Hand back the id so a retry cannot
    // duplicate it.
    return failure.sent
      ? withRetryHint({ ok: false, error: failure.message }, call.requestId)
      : { ok: false, error: failure.message };
  }
  if (!isResponse(reply))
    return withRetryHint(
      { ok: false, error: "Lanework returned an invalid response" },
      call.requestId,
    );
  if (reply.ok) return reply as ControlOutput;
  return withRetryHint(reply as ControlOutput, call.requestId);
}
