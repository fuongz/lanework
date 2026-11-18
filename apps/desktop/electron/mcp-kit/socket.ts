// lanework-kit's client for the app's kit socket (FE-152): the running app's
// warm fff index and natives, over `<app home>/run/kit.sock`. The wire format
// is `../main/kit-socket.ts`'s header.
//
// - One connection, opened on the first call and kept while it works.
// - A socket that is not there, refuses, or drops mid-call is "no app":
//   {@link KitSocketClient.call} answers {@link NO_SOCKET} and the caller runs
//   the tool itself. The kit's tools only read, so running one again is safe.
//
// NOTE: No Electron here, nor any main-process module that has one.
import { connect, type Socket } from "node:net";
import { KitError, type KitErrorCode } from "../kit";

/** What {@link KitSocketClient.call} answers when there is no app to ask. */
export const NO_SOCKET: unique symbol = Symbol("no kit socket");

/** How long one call waits for the app before it gives up on it. */
const CALL_MS = 120_000;
/** How long a connect may take before the app counts as not there. */
const CONNECT_MS = 1_000;
/** After a failed connect, how long the socket is not tried again. */
const RETRY_MS = 5_000;

const CODES = new Set<KitErrorCode>([
  "invalid",
  "scope",
  "not_found",
  "unavailable",
  "timeout",
  "aborted",
  "busy",
  "internal",
]);

interface Pending {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class KitSocketClient {
  readonly #path: string;
  #socket: Promise<Socket | null> | null = null;
  #failedAt = 0;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Run `method` in the app.
   *
   * @returns The tool's result, or {@link NO_SOCKET} when the app is not
   *   there, is busy, or went away before it answered.
   * @throws {KitError} The tool's own failure, as the app reported it.
   */
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown | typeof NO_SOCKET> {
    const socket = await this.#connect();
    if (!socket) return NO_SOCKET;
    if (socket.destroyed) {
      this.#socket = null;
      return NO_SOCKET;
    }
    const id = this.#nextId++;
    const answer = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({
          error: {
            code: "timeout",
            message: "The app did not answer in time.",
          },
        });
      }, CALL_MS);
      this.#pending.set(id, { resolve, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    if (answer === NO_SOCKET) return NO_SOCKET;
    const { result, error } = answer as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (!error) return result ?? null;
    const code = CODES.has(error.code as KitErrorCode)
      ? (error.code as KitErrorCode)
      : "internal";
    // Too many calls in the app: this process runs it instead.
    if (code === "busy") return NO_SOCKET;
    throw new KitError(code, String(error.message ?? "The call failed."));
  }

  /** Close the connection; calls still waiting answer {@link NO_SOCKET}. */
  close(): void {
    void this.#socket?.then((socket) => socket?.destroy());
    this.#socket = null;
    this.#drop();
  }

  #drop(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(NO_SOCKET);
    }
  }

  #connect(): Promise<Socket | null> {
    if (this.#socket) return this.#socket;
    if (Date.now() - this.#failedAt < RETRY_MS) return Promise.resolve(null);
    const opened = new Promise<Socket | null>((resolve) => {
      if (process.platform === "win32") return resolve(null);
      const socket = connect(this.#path);
      const timer = setTimeout(() => fail(), CONNECT_MS);
      const fail = () => {
        clearTimeout(timer);
        socket.destroy();
        this.#failedAt = Date.now();
        this.#socket = null;
        resolve(null);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        this.#listen(socket);
        // An idle connection never keeps this process alive.
        socket.unref();
        resolve(socket);
      });
    });
    this.#socket = opened;
    return opened;
  }

  #listen(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        let message: { id?: unknown };
        try {
          message = JSON.parse(line) as { id?: unknown };
        } catch {
          continue;
        }
        if (typeof message.id !== "number") continue;
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        pending.resolve(message);
      }
    });
    const gone = () => {
      if (this.#socket) this.#socket = null;
      this.#drop();
    };
    socket.on("error", () => socket.destroy());
    socket.once("close", gone);
  }
}
