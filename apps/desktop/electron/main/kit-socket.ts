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
// - `note`: only from lwk (see Backends), when it changed the ask.
//
// Backends (FE-158, FE-161): once the scope is resolved, a call goes to the
// TS kit (`ts`), to `lwk` through the app's lwk client (`lwk`, its answer
// and errors served as they are), or to both: `shadow` serves the TS answer
// and asks lwk in the background, `lwk-shadow` (the default) serves lwk's
// and runs the TS kit in the background; the two are compared in
// `./kit-shadow.ts`. lwk gets the tool's params plus `cwd` and
// `roots` set to the resolved scope. The backend is not a user setting yet:
// `LANEWORK_KIT_BACKEND`, else `backend` in `<app home>/kit.json`
// (`{"backend": "shadow"}`), else {@link DEFAULT_KIT_BACKEND}; the file is
// read again at most every {@link BACKEND_TTL_MS}. Without an lwk client it
// is always `ts`.
//
// Limits: a request line over 1 MB closes the connection; more than
// {@link INFLIGHT_PER_CONNECTION} calls on one connection, or
// {@link INFLIGHT_MAX} in all, are answered `busy`. A client that
// disconnects aborts its calls (their rg children are killed).
//
// NOTE: Nothing here imports Electron; `index.ts` starts it and closes it at
// quit.
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
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
import {
  createKitShadow,
  type KitShadow,
  kitShadowLogPath,
  timed,
} from "./kit-shadow";
// Types only: the lwk client is handed in, so this module (which the
// lanework-kit MCP server bundles) never loads lwk-serve.
import type { LwkAnswer, LwkMode, LwkToolMethod } from "./lwk-serve";
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

/** The most the TS kit runs in the background of an lwk answer (FE-161). */
const TS_SHADOW_MS = 15_000;

/** How long a read of `kit.json`'s backend is reused. */
const BACKEND_TTL_MS = 5_000;

/** Where a call goes once its scope is resolved (FE-158). */
export const KIT_BACKENDS = ["ts", "shadow", "lwk", "lwk-shadow"] as const;
export type KitBackend = (typeof KIT_BACKENDS)[number];
/** The backend with no env or `kit.json` saying otherwise (FE-161). */
export const DEFAULT_KIT_BACKEND: KitBackend = "lwk-shadow";

const isBackend = (value: unknown): value is KitBackend =>
  (KIT_BACKENDS as readonly unknown[]).includes(value);

/** The kit's internal flags: `<app home>/kit.json`. */
export function kitFlagsPath(home = appHomeDir()): string {
  return join(home, "kit.json");
}

/**
 * The backend now in force: `LANEWORK_KIT_BACKEND`, else `kit.json`'s
 * `backend`, else `ts`. An unknown value is `ts`, warned once.
 */
function backendReader(home: string | undefined): () => Promise<KitBackend> {
  let cached: { value: KitBackend; at: number } | null = null;
  const warned = new Set<string>();
  const pick = (value: unknown, where: string): KitBackend | null => {
    if (value === undefined || value === null || value === "") return null;
    if (isBackend(value)) return value;
    const key = `${where}=${String(value)}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[kit-socket] unknown kit backend ${key}; using ts`);
    }
    return "ts";
  };
  return async () => {
    const env = pick(process.env.LANEWORK_KIT_BACKEND, "LANEWORK_KIT_BACKEND");
    if (env) return env;
    if (cached && Date.now() - cached.at < BACKEND_TTL_MS) return cached.value;
    const saved = await readFile(kitFlagsPath(home), "utf8")
      .then((text) => (JSON.parse(text) as { backend?: unknown }).backend)
      .catch(() => undefined);
    cached = {
      value: pick(saved, "kit.json backend") ?? DEFAULT_KIT_BACKEND,
      at: Date.now(),
    };
    return cached.value;
  };
}

/** lwk-serve's codes in the kit's; `cancelled` is the caller going away. */
function lwkError(error: unknown): KitError {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : String(error);
  if (code === "cancelled") return new KitError("aborted", text);
  return toKitError(
    typeof code === "string" &&
      [
        "invalid",
        "scope",
        "not_found",
        "unavailable",
        "timeout",
        "aborted",
        "busy",
        "internal",
      ].includes(code)
      ? new KitError(code as KitError["code"], text)
      : new KitError("internal", text),
  );
}

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
  /**
   * The app's lwk client (`lwk-serve.ts`), for the `shadow` and `lwk`
   * backends; every call goes to the TS kit when unset.
   */
  lwk?: {
    call: (
      method: LwkToolMethod,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<LwkAnswer>;
    /** Its Power mode. */
    mode?: () => LwkMode;
  };
  /**
   * The app home `kit.json` and the shadow log are under; {@link appHomeDir}
   * when unset.
   */
  home?: string;
  /** The backend for each call; read from the env and `kit.json` when unset. */
  backend?: () => KitBackend | Promise<KitBackend>;
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
function line(
  id: unknown,
  body: { result: unknown; note?: string } | { error: KitError },
) {
  const safeId = typeof id === "string" || typeof id === "number" ? id : null;
  if ("error" in body)
    return `${JSON.stringify({
      id: safeId,
      error: { code: body.error.code, message: body.error.message },
    })}\n`;
  return `${JSON.stringify(
    typeof body.note === "string"
      ? { id: safeId, result: body.result ?? null, note: body.note }
      : { id: safeId, result: body.result ?? null },
  )}\n`;
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

  const lwk = options.lwk;
  const backendOf = options.backend ?? backendReader(options.home);
  let shadow: KitShadow | null = null;
  const shadowLog = (): KitShadow => {
    shadow ??= createKitShadow({
      logFile: kitShadowLogPath(options.home),
    });
    return shadow;
  };

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
        const backend: KitBackend = lwk
          ? await Promise.resolve(backendOf()).catch(() => "ts" as const)
          : "ts";
        const lwkParams = {
          ...rest,
          // The TS kit's fff always ranks with git signals; lwk only when
          // asked (BE-04), so ask, or the two orders differ.
          ...(method === "find_files" && rest.git === undefined
            ? { git: true }
            : {}),
          cwd: ctx.cwd,
          roots: [...(ctx.roots ?? [ctx.cwd])],
        };
        if (lwk && backend === "lwk-shadow") {
          // FE-161: lwk answers; the TS kit runs the same call in the
          // background, bounded, and the two are compared and logged. When
          // lwk cannot answer at all (no binary, crashed past its backoff)
          // the TS answer is served instead.
          const answered = lwk.call(method, lwkParams, controller.signal);
          const background = {
            ...ctx,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(TS_SHADOW_MS),
            ]),
          };
          const tsRun = KIT_METHODS[method](rest, background);
          tsRun.catch(() => {});
          try {
            shadowLog().compare(
              method,
              lwkParams,
              timed(async () => ({ result: await tsRun })),
              () => answered,
              controller.signal,
              "lwk",
            );
          } catch (error) {
            console.warn("[kit-socket] shadow failed to start", error);
          }
          const answer = await answered.catch((error: unknown) => {
            const kitError = lwkError(error);
            if (kitError.code !== "unavailable") throw kitError;
            return null;
          });
          send(line(id, answer ?? { result: await tsRun }));
          return;
        }
        if (lwk && backend === "lwk") {
          const answer = await lwk
            .call(method, lwkParams, controller.signal)
            .catch((error: unknown) => {
              throw lwkError(error);
            });
          send(line(id, answer));
          return;
        }
        const run = KIT_METHODS[method](rest, ctx);
        if (lwk && backend === "shadow")
          try {
            shadowLog().compare(
              method,
              lwkParams,
              timed(async () => ({ result: await run })),
              (signal) => lwk.call(method, lwkParams, signal),
              controller.signal,
            );
          } catch (error) {
            console.warn("[kit-socket] shadow failed to start", error);
          }
        send(line(id, { result: await run }));
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
      await shadow?.flush();
      // Only ours: another instance may have taken the path since.
      const now = await lstat(path).catch(() => null);
      if (now?.isSocket() && now.ino === made.ino)
        await unlink(path).catch(() => {});
    },
  };
}
