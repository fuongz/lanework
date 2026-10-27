// The control server (FE-87): where a lead's CLI reaches its run.
//
// - TCP on 127.0.0.1, a port the OS picks. One connection carries one JSON
//   line in (`ControlRequest`) and one JSON line out (`ControlResponse`).
// - The token picks the run; a wrong or revoked one is refused before any
//   input is looked at. Whether the lead is in a turn is the run's to check.
// - A call that takes too long answers with its request id: the CLI retries
//   with that same id, and the run applies it at most once.
//
// Nothing here imports Electron.

import { createServer, type Socket } from "node:net";
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

/** How long a client has to send its line. */
const READ_TIMEOUT_MS = 5_000;
/** How long a call may take before the CLI is told to retry it. */
const CALL_TIMEOUT_MS = 35_000;
/** Connections handled at once; more are refused. */
const PENDING_MAX = 24;

const UNAUTHORIZED = "Connection revoked or unauthorized";

export interface ControlServerOptions {
  control: OrchestrationMainHandlers["control"];
  /** The run a token belongs to, or null. */
  runOfToken: (token: string) => string | null;
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
  const token =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { token?: unknown }).token
      : undefined;
  const runId = typeof token === "string" ? options.runOfToken(token) : null;
  if (!runId) return { ok: false, error: UNAUTHORIZED, retryable: false };
  let request: ReturnType<typeof parseControlRequest>;
  try {
    request = parseControlRequest(value);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid request",
      retryable: false,
    };
  }
  const { token: _token, requestId, ...call } = request;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      options.control(runId, call, requestId),
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
  let pending = 0;
  let endpoint: string | null = null;
  const server = createServer((socket) => {
    if (pending >= PENDING_MAX) {
      reply(socket, {
        ok: false,
        error: "Too many control calls at once; retry in a moment.",
        retryable: true,
      });
      return;
    }
    pending++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pending--;
    };
    socket.once("close", finish);
    socket.once("error", () => {
      finish();
      socket.destroy();
    });
    let buffer = "";
    let taken = false;
    socket.setTimeout(READ_TIMEOUT_MS, () => {
      if (!taken) socket.destroy();
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (taken) return;
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) {
        if (buffer.length > CONTROL_INPUT_MAX) {
          taken = true;
          reply(socket, {
            ok: false,
            error: `The request is larger than ${CONTROL_INPUT_MAX} bytes`,
            retryable: false,
          });
        }
        return;
      }
      taken = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, at);
      if (line.length > CONTROL_INPUT_MAX) {
        reply(socket, {
          ok: false,
          error: `The request is larger than ${CONTROL_INPUT_MAX} bytes`,
          retryable: false,
        });
        return;
      }
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
