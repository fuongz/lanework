// The kit's socket (FE-152): lanework-kit's tools served by the running app,
// so `lwk` and the lanework-kit MCP server get the app's warm fff index and
// its natives instead of cold ones of their own.
//
// Where: `<app home>/run/kit.sock` (`~/.lanew/run/kit.sock`). The app makes
// it at startup and removes it at quit. The folder is 0700 and the socket
// 0600: only this user connects. A stale socket is removed at start; a live
// one (another app instance) is left alone and this one serves nothing. The
// path is never followed when it is a symlink. Not on Windows.
//
// Wire format: newline-delimited JSON, UTF-8, both ways. One connection
// carries any number of requests; answers come back in the order the calls
// finish, matched by `id`.
//
//   → {"id": 1, "method": "find_files",
//      "params": {"query": "kit", "folder": "apps", "limit": 20,
//                 "cwd": "/abs/where/the/agent/runs",
//                 "roots": ["/abs/narrower/root"]}}
//   ← {"id": 1, "result": [{"path": "apps/desktop/…", "score": 812}]}
//   ← {"id": 2, "error": {"code": "scope", "message": "…"}}
//
// - `id`: a string or a number, echoed back; null when the line was not
//   JSON or had none.
// - `method`: `find_files`, `search_text`, `search_structural`,
//   `list_files`, `search_sessions` (the kit's tools, `../kit/core.ts`), or
//   `ping`, answered `{"methods": [...]}`.
// - `params`: the tool's own params, plus `cwd` (required, absolute: the
//   default folder) and `roots` (optional, absolute: narrows the scope).
//   The scope is `cwd` and, when `cwd` is inside a project's linked folder,
//   every folder of that project; `roots`, when given, must each lie inside
//   that scope and replace it.
// - `error.code`: a `KitErrorCode` (`invalid`, `scope`, `not_found`,
//   `unavailable`, `timeout`, `aborted`, `busy`, `internal`).
//
// Limits: a request line over 1 MB closes the connection; more than
// {@link INFLIGHT_PER_CONNECTION} calls on one connection, or
// {@link INFLIGHT_MAX} in all, are answered `busy`. A client that
// disconnects aborts its calls (their rg children are killed).
//
// NOTE: Nothing here imports Electron; `index.ts` starts it and closes it at
// quit.
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import {
  isKitMethod,
  isWithin,
  KIT_METHODS,
  type KitContext,
  KitError,
  type KitNatives,
  realRoots,
  toKitError,
} from "../kit";
import { appHomeDir } from "./paths";

/** The longest request line taken, in bytes. */
const REQUEST_MAX = 1024 * 1024;
/** Calls running at once on one connection. */
const INFLIGHT_PER_CONNECTION = 4;
/** Calls running at once over every connection. */
const INFLIGHT_MAX = 16;
/** Connections open at once. */
const CONNECTIONS_MAX = 32;
/** The most `roots` one request names. */
const ROOTS_MAX = 32;
/** The longest path `sockaddr_un` takes on macOS, with its NUL. */
const SOCKET_PATH_MAX = 103;
/** How long a probe of an existing socket waits for it to answer. */
const PROBE_MS = 500;

/** The socket's path: `<app home>/run/kit.sock`. */
export function kitSocketPath(home = appHomeDir()): string {
  return join(home, "run", "kit.sock");
}

export interface KitSocketOptions {
  /** {@link kitSocketPath} when unset. */
  path?: string;
  /**
   * The folders a caller in `cwd` may also reach: the linked folders of the
   * project `cwd` is in. None when unset.
   */
  rootsFor?: (cwd: string) => Promise<string[]>;
  /** The kit's natives; the app's own when unset. */
  natives?: KitNatives;
}

export interface KitSocket {
  path: string;
  /** Stop serving, abort every call, and remove the socket if it is still ours. */
  close: () => Promise<void>;
}

/** Whether a live server answers at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (live: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/**
 * The run folder, made 0700 and checked: a real folder, not a symlink,
 * owned by this user.
 *
 * @throws When it cannot be made safe.
 */
async function runDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${dir} is not a folder.`);
  if (process.getuid && info.uid !== process.getuid())
    throw new Error(`${dir} belongs to another user.`);
  if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}

/**
 * Clear `path` for a new socket: a stale socket, a file or a symlink is
 * removed (the link itself, never what it points to).
 *
 * @returns False when a live server already answers there.
 * @throws When it is a folder.
 */
async function clearPath(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (!info) return true;
  if (info.isDirectory()) throw new Error(`${path} is a folder.`);
  if (info.isSocket() && (await answers(path))) return false;
  await unlink(path);
  return true;
}

/**
 * Listen on `path` with 0600 from the first moment.
 *
 * NOTE: The umask is set around `listen` only. Node binds a pipe within
 * that call, so the socket is never there with a wider mode; the chmod
 * after is the belt to that.
 */
function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const before = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(before);
    }
  });
}

/** One answer, as its line. */
function line(id: unknown, body: { result: unknown } | { error: KitError }) {
  const safeId = typeof id === "string" || typeof id === "number" ? id : null;
  if ("error" in body)
    return `${JSON.stringify({
      id: safeId,
      error: { code: body.error.code, message: body.error.message },
    })}\n`;
  return `${JSON.stringify({ id: safeId, result: body.result ?? null })}\n`;
}

/**
 * The caller's {@link KitContext} from a request's `cwd` and `roots`.
 *
 * @throws {KitError} `invalid` for a missing or relative `cwd` or bad
 *   `roots`; `scope` for a root outside what `cwd` may reach.
 */
async function contextOf(
  params: Record<string, unknown>,
  options: KitSocketOptions,
  signal: AbortSignal,
): Promise<KitContext> {
  const { cwd, roots } = params;
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    throw new KitError("invalid", "params.cwd must be an absolute path.");
  const linked = options.rootsFor ? await options.rootsFor(cwd) : [];
  const scope = [cwd, ...linked];
  if (roots === undefined || roots === null)
    return { cwd, roots: scope, signal, natives: options.natives };
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    roots.length > ROOTS_MAX ||
    roots.some((root) => typeof root !== "string" || !isAbsolute(root))
  )
    throw new KitError(
      "invalid",
      `params.roots must be 1 to ${ROOTS_MAX} absolute paths.`,
    );
  const allowed = await realRoots(scope);
  for (const root of roots as string[]) {
    const [real] = await realRoots([root]);
    if (!real || !allowed.some((outer) => isWithin(outer, real)))
      throw new KitError(
        "scope",
        `${root} is outside this project's folders (${allowed.join(", ")}).`,
      );
  }
  return { cwd, roots: roots as string[], signal, natives: options.natives };
}

/**
 * Start serving the kit at `options.path`.
 *
 * @returns The socket, or null when it is not served: on Windows, a path
 *   too long for a socket, or another app instance serving already.
 * @throws When the run folder or the path cannot be made safe.
 */
export async function startKitSocket(
  options: KitSocketOptions = {},
): Promise<KitSocket | null> {
  if (process.platform === "win32") return null;
  const path = options.path ?? kitSocketPath();
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) {
    console.warn(`[kit-socket] the path is too long for a socket: ${path}`);
    return null;
  }
  await runDir(dirname(path));
  if (!(await clearPath(path))) {
    console.warn("[kit-socket] another Lanework serves the kit already");
    return null;
  }

  let inflight = 0;
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    const calls = new Set<AbortController>();
    let buffered: Buffer[] = [];
    let size = 0;

    const send = (text: string) => {
      if (!socket.destroyed && socket.writable) socket.write(text);
    };

    const handle = async (raw: string) => {
      let request: unknown;
      try {
        request = JSON.parse(raw);
      } catch {
        return send(
          line(null, { error: new KitError("invalid", "Not JSON.") }),
        );
      }
      if (typeof request !== "object" || request === null) {
        return send(
          line(null, {
            error: new KitError("invalid", "A request is a JSON object."),
          }),
        );
      }
      const { id, method, params } = request as Record<string, unknown>;
      if (method === "ping")
        return send(
          line(id, { result: { methods: Object.keys(KIT_METHODS) } }),
        );
      if (!isKitMethod(method))
        return send(
          line(id, {
            error: new KitError("invalid", `Unknown method: ${String(method)}`),
          }),
        );
      if (calls.size >= INFLIGHT_PER_CONNECTION || inflight >= INFLIGHT_MAX)
        return send(
          line(id, {
            error: new KitError("busy", "Too many calls at once. Try again."),
          }),
        );
      const controller = new AbortController();
      calls.add(controller);
      inflight += 1;
      try {
        if (
          typeof params !== "object" ||
          params === null ||
          Array.isArray(params)
        )
          throw new KitError("invalid", "params must be an object.");
        const {
          cwd: _cwd,
          roots: _roots,
          ...rest
        } = params as Record<string, unknown>;
        const ctx = await contextOf(
          params as Record<string, unknown>,
          options,
          controller.signal,
        );
        const result = await KIT_METHODS[method](rest, ctx);
        send(line(id, { result }));
      } catch (error) {
        send(line(id, { error: toKitError(error, controller.signal) }));
      } finally {
        calls.delete(controller);
        inflight -= 1;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(0x0a, start);
        if (end === -1) break;
        const piece = chunk.subarray(start, end);
        start = end + 1;
        if (size + piece.length > REQUEST_MAX) return tooLarge();
        const raw = Buffer.concat([...buffered, piece]).toString("utf8");
        buffered = [];
        size = 0;
        if (raw.trim()) void handle(raw);
      }
      const rest = chunk.subarray(start);
      if (rest.length === 0) return;
      if (size + rest.length > REQUEST_MAX) return tooLarge();
      buffered.push(rest);
      size += rest.length;
    });
    const tooLarge = () => {
      buffered = [];
      size = 0;
      send(
        line(null, {
          error: new KitError("invalid", "A request is 1 MB at most."),
        }),
      );
      socket.end();
      socket.destroySoon?.();
    };
    // A client that goes away takes its calls with it.
    socket.once("close", () => {
      connections.delete(socket);
      for (const controller of calls) controller.abort();
    });
    socket.on("error", () => socket.destroy());
  });
  server.maxConnections = CONNECTIONS_MAX;
  server.on("error", (error) => console.warn("[kit-socket]", error));

  await listen(server, path);
  const made = await lstat(path);
  if (!made.isSocket()) {
    server.close();
    throw new Error(`${path} is not the socket just made.`);
  }
  await chmod(path, 0o600);

  let closed = false;
  return {
    path,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Only ours: another instance may have taken the path since.
      const now = await lstat(path).catch(() => null);
      if (now?.isSocket() && now.ino === made.ino)
        await unlink(path).catch(() => {});
    },
  };
}
