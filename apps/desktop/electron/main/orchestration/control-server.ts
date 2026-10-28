// The control server (FE-87): where a lead's CLI reaches its run.
//
// - TCP on 127.0.0.1, a port the OS picks. One connection carries one JSON
//   line in (`ControlRequest`) and one JSON line out (`ControlResponse`).
// - The token picks the run; a wrong or revoked one is refused before any
//   input is looked at. Whether the lead is in a turn is the run's to check.
// - A call that takes too long answers with its request id: the CLI retries
//   with that same id, and the run applies it at most once.
// - A client has READ_TIMEOUT_MS from connecting to its newline, however
//   slowly it sends (FE-89/D9): a socket that dribbles a byte at a time is
//   closed at the deadline, not kept alive by each byte. The lines still
//   being read share PENDING_BYTES_MAX, so a few large slow ones cannot hold
//   the app's memory either.
//
// - A `sessions.*` action is a conductor's (conductor-sessions.ts): its token
//   names the process that sent it, not a run.
//
// Nothing here imports Electron.

import { createServer, type Socket } from "node:net";
import {
  isSessionAction,
  parseSessionRequest,
  type SessionCall,
} from "../../../shared/conductor-sessions";
import {
  CONTROL_INPUT_MAX,
  CONTROL_RESPONSE_MAX,
  ControlInputError,
  type ControlResponse,
  type ControlServer,
  type OrchestrationMainHandlers,
  parseControlRequest,
} from "../../../shared/orchestration";
import { ControlRefusal } from "./runtime";

/** How long a client has, from connecting, to send its whole line. */
const READ_TIMEOUT_MS = 5_000;
/** How long a call may take before the CLI is told to retry it. */
const CALL_TIMEOUT_MS = 35_000;
/** Connections handled at once; more are refused. */
const CONNECTIONS_MAX = 24;
/** The most bytes of request lines held at once, over every connection. */
const PENDING_BYTES_MAX = 2 * CONTROL_INPUT_MAX;

const UNAUTHORIZED = "Connection revoked or unauthorized";

/** A conductor's sessions, as the server reaches them. */
export interface SessionsControl<Caller = unknown> {
  /** The process a token was minted for, or null. */
  callerOf: (token: string) => Caller | null;
  call: (
    caller: Caller,
    call: SessionCall,
    requestId: string,
  ) => Promise<unknown>;
}

export interface ControlServerOptions {
  control: OrchestrationMainHandlers["control"];
  /** The run a token belongs to, or null. */
  runOfToken: (token: string) => string | null;
  /** Absent: every `sessions.*` call is refused. */
  sessions?: SessionsControl;
  /** Told the endpoint once the server listens. */
  listening?: (endpoint: string) => void;
}

function reply(socket: Socket, response: ControlResponse): void {
  let line = JSON.stringify(response);
  if (line.length > CONTROL_RESPONSE_MAX)
    line = JSON.stringify({
      ok: false,
      error:
        "The answer is too large to send. Use get for one task instead of list or wait.",
      retryable: false,
    } satisfies ControlResponse);
  socket.end(`${line}\n`);
}

/** Answer one request line. */
async function answer(
  line: string,
  options: ControlServerOptions,
): Promise<ControlResponse> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "The request is not JSON", retryable: false };
  }
  // The token first: nothing about the input is said to a caller without one.
  const fields =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { token?: unknown; action?: unknown })
      : {};
  const { token } = fields;
  if (isSessionAction(fields.action)) {
    const sessions = options.sessions;
    const caller =
      typeof token === "string" ? (sessions?.callerOf(token) ?? null) : null;
    if (!sessions || !caller)
      return { ok: false, error: UNAUTHORIZED, retryable: false };
    let request: ReturnType<typeof parseSessionRequest>;
    try {
      request = parseSessionRequest(value);
    } catch (error) {
      return invalid(error);
    }
    const { token: _token, requestId, ...call } = request;
    return settle(
      Promise.resolve().then(() => sessions.call(caller, call, requestId)),
      requestId,
    );
  }
  const runId = typeof token === "string" ? options.runOfToken(token) : null;
  if (!runId) return { ok: false, error: UNAUTHORIZED, retryable: false };
  let request: ReturnType<typeof parseControlRequest>;
  try {
    request = parseControlRequest(value);
  } catch (error) {
    return invalid(error);
  }
  const { token: _token, requestId, ...call } = request;
  return settle(options.control(runId, call, requestId), requestId);
}

function invalid(error: unknown): ControlResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Invalid request",
    retryable: false,
  };
}

/** A call's answer, or why it failed; one that takes too long is retried. */
async function settle(
  pending: Promise<unknown>,
  requestId: string,
): Promise<ControlResponse> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ControlRefusal || error instanceof ControlInputError)
      return { ok: false, error: error.message, retryable: false };
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        message === "timeout"
          ? "The call is still running. Retry it with the same requestId to get its answer."
          : message,
      requestId,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Listen on loopback.
 *
 * @throws When the port cannot be bound.
 */
export function listenControl(
  options: ControlServerOptions,
): Promise<ControlServer> {
  let connections = 0;
  /** Bytes buffered by connections still sending their line. */
  let pendingBytes = 0;
  let endpoint: string | null = null;
  const server = createServer((socket) => {
    if (connections >= CONNECTIONS_MAX) {
      reply(socket, {
        ok: false,
        error: "Too many control calls at once; retry in a moment.",
        retryable: true,
      });
      return;
    }
    connections++;
    let taken = false;
    // An absolute deadline: unlike `socket.setTimeout`, data does not reset it.
    const deadline = setTimeout(() => {
      if (!taken) socket.destroy();
    }, READ_TIMEOUT_MS);
    let chunks: Buffer[] = [];
    /** What this connection adds to `pendingBytes` now. */
    let held = 0;
    const release = () => {
      pendingBytes -= held;
      held = 0;
      chunks = [];
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      connections--;
      clearTimeout(deadline);
      release();
    };
    socket.once("close", finish);
    socket.once("error", () => {
      finish();
      socket.destroy();
    });
    const refuse = (error: string, retryable: boolean) => {
      taken = true;
      clearTimeout(deadline);
      release();
      reply(socket, { ok: false, error, retryable });
    };
    socket.on("data", (chunk: Buffer) => {
      if (taken) return;
      const at = chunk.indexOf(0x0a);
      const part = at < 0 ? chunk : chunk.subarray(0, at);
      if (held + part.length > CONTROL_INPUT_MAX) {
        refuse(`The request is larger than ${CONTROL_INPUT_MAX} bytes`, false);
        return;
      }
      if (pendingBytes + part.length > PENDING_BYTES_MAX) {
        refuse("Too many control calls at once; retry in a moment.", true);
        return;
      }
      chunks.push(part);
      held += part.length;
      pendingBytes += part.length;
      if (at < 0) return;
      taken = true;
      clearTimeout(deadline);
      const line = Buffer.concat(chunks).toString("utf8");
      release();
      void answer(line, options).then(
        (response) => {
          if (!socket.destroyed) reply(socket, response);
        },
        () => socket.destroy(),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("The control server has no port"));
        return;
      }
      endpoint = `127.0.0.1:${address.port}`;
      options.listening?.(endpoint);
      resolve({
        endpoint: () => endpoint,
        close: () =>
          new Promise<void>((done) => {
            endpoint = null;
            server.close(() => done());
          }),
      });
    });
  });
}
