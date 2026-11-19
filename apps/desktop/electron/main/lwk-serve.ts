// The app's client for `lwk serve` (FE-158): the kit's five tools answered
// by the native `lwk`, either from one long-lived process or one run per
// call, as Settings → Power saver → Search engine (lwk) says (D1a).
//
// Modes:
//
// - `always` (the default, FE-161): one `lwk serve` (no idle exit), started
//   at app start and kept running; fastest, and its RAM cache stays warm.
// - `on-demand`: `lwk serve --idle-exit 300`, started by the
//   first call and started again by the next call after it has exited.
// - `per-call`: `lwk <find|grep|sg|ls|sessions> ... --json` for each call;
//   nothing stays resident.
//
// Wire (lwk's `contract/serve.md`): newline-delimited JSON on the child's
// stdin and stdout, `{id, method, params}` out, `{id, result[, note]}` or
// `{id, error: {code, message}}` back, in the order calls finish. The tool
// methods and params are the kit socket's (`kit-socket.ts`), `cwd` and
// `roots` included. The child's stderr (one JSON log line per request) is
// read and only kept for a crash's log line.
//
// - A started process is sent `hello` first and refused (logged, and every
//   call fails `unavailable`) when its contract major is not the pinned one.
// - A crash fails the calls it had in flight with `unavailable`; the next
//   start waits out an exponential backoff (and `always` restarts on its own
//   after it). An idle exit is not a crash: calls caught by it are sent
//   again to a fresh process.
// - A caller's AbortSignal sends `cancel {id}`; the call then fails with
//   lwk's `cancelled`.
// - {@link LwkServe.setMode} applies at once; {@link LwkServe.shutdown}
//   sends `shutdown` and kills what has not exited after a short wait.
//
// NOTE: No Electron import, and nothing is ever written to the app's own
// stdout: logs go through `console.warn`/`console.error` (stderr), the main
// process's logger, or the `log` option.
import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import lwkLock from "../../lwk.lock.json";
import { LWK_MODES, type LwkMode } from "../../shared/conversation";
import { lwkBinaryPath } from "./agent-setup/lwk-install";

export { LWK_MODES, type LwkMode };

/** The kit's tool methods, as `kit.sock` and `lwk serve` name them. */
export const LWK_TOOL_METHODS = [
  "find_files",
  "search_text",
  "search_structural",
  "list_files",
  "search_sessions",
] as const;
export type LwkToolMethod = (typeof LWK_TOOL_METHODS)[number];

/** The contract's `errorCodes` (`cancelled` is lwk serve's own). */
export type LwkErrorCode =
  | "invalid"
  | "scope"
  | "not_found"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "cancelled"
  | "busy"
  | "internal";

export class LwkServeError extends Error {
  constructor(
    readonly code: LwkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LwkServeError";
  }
}

/** A tool's answer: its result and, when the tool changed the ask, a note. */
export interface LwkAnswer {
  result: unknown;
  note?: string;
}

export interface LwkLog {
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface LwkServeOptions {
  /** This build's `lwk`; {@link lwkBinaryPath} when unset. */
  binary?: string;
  /** The starting mode; `always` when unset. */
  mode?: LwkMode;
  /** `--idle-exit` in on-demand mode, in seconds; 300 when unset. */
  idleExitSecs?: number;
  /**
   * The contract major the app pins; read from `lwk.lock.json` when unset
   * (and 1 when there is none).
   */
  contractMajor?: number;
  /** stderr through `console.warn`/`console.error` when unset. */
  log?: LwkLog;
}

export interface LwkServe {
  /**
   * Run `method` with `params` (`cwd` required, `roots` optional, as on
   * `kit.sock`).
   *
   * @throws {LwkServeError} With the contract's code.
   */
  call: (
    method: LwkToolMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<LwkAnswer>;
  /** The mode now in force. */
  mode: () => LwkMode;
  /** Switch modes now; `always` starts the process, `per-call` stops it. */
  setMode: (mode: LwkMode) => void;
  /** Send `shutdown`, kill whatever is still running after a short wait. */
  shutdown: () => Promise<void>;
  /** The resident process's pid, if one runs (for diagnostics). */
  pid: () => number | null;
}

/** On-demand's `--idle-exit`: 5 minutes. */
const IDLE_EXIT_SECS = 300;
/** How long `hello` may take before the start counts as failed. */
const HELLO_MS = 5_000;
/** How long `shutdown` waits for an exit before it kills. */
const SHUTDOWN_MS = 1_500;
/** How long a cancelled call waits for lwk's `cancelled` before giving up. */
const CANCEL_GRACE_MS = 2_000;
/** First backoff after a crash; doubled per crash in a row, up to the max. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** The longest backoff a call waits out instead of failing. */
const BACKOFF_WAIT_MAX_MS = 2_000;
/** A process that lived this long resets the backoff. */
const HEALTHY_MS = 60_000;
/** Lines of the child's stderr kept for a crash's log line. */
const STDERR_KEPT = 5;
/** Per-call mode: the most a CLI run's stdout may hold. */
const CLI_STDOUT_MAX = 64 * 1024 * 1024;

/** The contract major the app pins: `lwk.lock.json`, bundled at build time. */
function pinnedContractMajor(log: LwkLog): number {
  const major = majorOf(lwkLock.contract);
  if (major !== null) return major;
  log.warn("[lwk-serve] lwk.lock.json names no contract version; taking 1.x.");
  return 1;
}

function majorOf(version: unknown): number | null {
  if (typeof version === "number" && Number.isInteger(version)) return version;
  if (typeof version !== "string") return null;
  const match = /^(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ERROR_CODES = new Set<string>([
  "invalid",
  "scope",
  "not_found",
  "unavailable",
  "timeout",
  "aborted",
  "cancelled",
  "busy",
  "internal",
]);

function errorFrom(value: unknown): LwkServeError {
  const error =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const code =
    typeof error.code === "string" && ERROR_CODES.has(error.code)
      ? (error.code as LwkErrorCode)
      : "internal";
  return new LwkServeError(
    code,
    typeof error.message === "string" ? error.message : "lwk failed.",
  );
}

// ─── The resident process ───────────────────────────────────────────────────

interface Pending {
  method: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  resolve: (answer: LwkAnswer) => void;
  reject: (error: LwkServeError) => void;
  /** Detach the abort listener and any cancel timer. */
  cleanup: () => void;
  /** Whether it is a tool call (sent again after an idle exit). */
  tool: boolean;
}

interface Resident {
  child: ChildProcess;
  idleExit: boolean;
  startedAt: number;
  /** Settles once `hello` has been answered and checked. */
  ready: Promise<void>;
  pending: Map<number, Pending>;
  stderr: string[];
  /** No new calls: it ends once the calls it has are answered. */
  retiring: boolean;
  /** We asked it to end (EOF, `shutdown` or a kill). */
  stopping: boolean;
  exited: Promise<void>;
}

/** A client for `lwk serve` in the given mode. */
export function createLwkServe(options: LwkServeOptions = {}): LwkServe {
  const log: LwkLog = options.log ?? {
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
  const binary = options.binary ?? lwkBinaryPath();
  const idleExitSecs = options.idleExitSecs ?? IDLE_EXIT_SECS;
  let contractMajor = options.contractMajor ?? null;
  let current: LwkMode = options.mode ?? "always";
  let resident: Resident | null = null;
  /** Retired processes still answering their last calls. */
  const retired = new Set<Resident>();
  /** Per-call children still running. */
  const runs = new Set<ChildProcess>();
  let nextId = 1;
  let crashes = 0;
  let notBefore = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the contract check refused the binary: no more starts. */
  let refused: LwkServeError | null = null;
  let closed = false;

  const pinned = (): number => {
    contractMajor ??= pinnedContractMajor(log);
    return contractMajor;
  };

  /** Write one request line; false when the pipe is gone. */
  const send = (
    proc: Resident,
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): boolean => {
    const stdin = proc.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(
      `${JSON.stringify(params ? { id, method, params } : { id, method })}\n`,
    );
    return true;
  };

  /** A control request (`hello`, `cancel`, `shutdown`) on `proc`. */
  const control = (
    proc: Resident,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<LwkAnswer> =>
    new Promise((resolveAnswer, rejectAnswer) => {
      const id = nextId++;
      proc.pending.set(id, {
        method,
        params: params ?? {},
        resolve: resolveAnswer,
        reject: rejectAnswer,
        cleanup: () => {},
        tool: false,
      });
      if (!send(proc, id, method, params)) {
        proc.pending.delete(id);
        rejectAnswer(new LwkServeError("unavailable", "lwk is not running."));
      }
    });

  const onLine = (proc: Resident, line: string) => {
    if (!line.trim()) return;
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn(`[lwk-serve] Not JSON on lwk's stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof answer.id !== "number") {
      // `id: null`: a line lwk could not read; ours are always JSON.
      log.warn(`[lwk-serve] lwk answered no call: ${line.slice(0, 200)}`);
      return;
    }
    const pending = proc.pending.get(answer.id);
    if (!pending) return;
    proc.pending.delete(answer.id);
    pending.cleanup();
    if ("error" in answer && answer.error)
      pending.reject(errorFrom(answer.error));
    else
      pending.resolve(
        typeof answer.note === "string"
          ? { result: answer.result, note: answer.note }
          : { result: answer.result },
      );
    if (proc.retiring && proc.pending.size === 0) endInput(proc);
  };

  /** Close the child's stdin: lwk serve exits 0 at EOF. */
  const endInput = (proc: Resident) => {
    proc.stopping = true;
    proc.child.stdin?.end();
    const timer = setTimeout(() => proc.child.kill("SIGKILL"), SHUTDOWN_MS);
    timer.unref?.();
    void proc.exited.then(() => clearTimeout(timer));
  };

  /** Stop taking calls on `proc`; it ends once its calls are answered. */
  const retire = (proc: Resident) => {
    if (resident === proc) resident = null;
    proc.retiring = true;
    retired.add(proc);
    void proc.exited.then(() => retired.delete(proc));
    if ([...proc.pending.values()].every((p) => !p.tool)) endInput(proc);
  };

  const scheduleRestart = () => {
    if (restartTimer || closed || refused || current !== "always") return;
    restartTimer = setTimeout(
      () => {
        restartTimer = null;
        if (current === "always" && !resident && !closed)
          void ensure().catch(() => {});
      },
      Math.max(0, notBefore - Date.now()),
    );
    restartTimer.unref?.();
  };

  const onExit = (
    proc: Resident,
    code: number | null,
    signalName: NodeJS.Signals | null,
  ) => {
    if (resident === proc) resident = null;
    const pending = [...proc.pending.values()];
    proc.pending.clear();
    const idle = !proc.stopping && code === 0 && proc.idleExit;
    if (idle || proc.stopping) {
      if (Date.now() - proc.startedAt >= HEALTHY_MS) crashes = 0;
    } else {
      crashes = Date.now() - proc.startedAt >= HEALTHY_MS ? 1 : crashes + 1;
      const backoff = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_MIN_MS * 2 ** (crashes - 1),
      );
      notBefore = Date.now() + backoff;
      log.error(
        `[lwk-serve] lwk serve (pid ${proc.child.pid}) ended (${
          signalName ?? `code ${code}`
        }) with ${pending.filter((p) => p.tool).length} call(s) in flight; next start in ${backoff} ms.${
          proc.stderr.length ? ` Last stderr: ${proc.stderr.join(" | ")}` : ""
        }`,
      );
    }
    for (const call of pending) {
      call.cleanup();
      // An idle exit raced a call: run it again on a fresh process.
      if (idle && call.tool && !call.signal?.aborted && !closed)
        dispatch(call.method as LwkToolMethod, call.params, call.signal).then(
          call.resolve,
          call.reject,
        );
      else
        call.reject(
          new LwkServeError(
            "unavailable",
            proc.stopping
              ? "lwk serve was stopped."
              : "lwk serve ended before it answered.",
          ),
        );
    }
    if (!idle && !proc.stopping) scheduleRestart();
  };

  const start = (): Resident => {
    const idleExit = current === "on-demand";
    const args = idleExit
      ? ["serve", "--idle-exit", String(idleExitSecs)]
      : ["serve"];
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let markExited: () => void = () => {};
    const proc: Resident = {
      child,
      idleExit,
      startedAt: Date.now(),
      ready: Promise.resolve(),
      pending: new Map(),
      stderr: [],
      retiring: false,
      stopping: false,
      exited: new Promise((done) => {
        markExited = done;
      }),
    };
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      for (let end = out.indexOf("\n"); end !== -1; end = out.indexOf("\n")) {
        const line = out.slice(0, end);
        out = out.slice(end + 1);
        onLine(proc, line);
      }
    });
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        proc.stderr.push(line.slice(0, 300));
        if (proc.stderr.length > STDERR_KEPT) proc.stderr.shift();
      }
    });
    // EPIPE after a crash: the exit handler reports it.
    child.stdin?.on("error", () => {});
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signalName) => {
      if (spawnError && child.pid === undefined) {
        notBefore = Date.now() + BACKOFF_MAX_MS;
        log.error(
          `[lwk-serve] Unable to start ${binary}: ${spawnError.message}`,
        );
      }
      onExit(proc, code, signalName);
      markExited();
    });
    proc.ready = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hello = await Promise.race([
        control(proc, "hello"),
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () =>
              fail(
                new LwkServeError(
                  "unavailable",
                  "lwk serve did not say hello.",
                ),
              ),
            HELLO_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      const result =
        hello.result && typeof hello.result === "object"
          ? (hello.result as Record<string, unknown>)
          : {};
      const major = majorOf(result.contract);
      if (major !== pinned()) {
        refused = new LwkServeError(
          "unavailable",
          `lwk ${String(result.lwk)} speaks contract ${String(
            result.contract,
          )}; this app needs ${pinned()}.x.`,
        );
        log.error(`[lwk-serve] Refused ${binary}: ${refused.message}`);
        proc.stopping = true;
        proc.child.kill("SIGKILL");
        throw refused;
      }
    })();
    proc.ready.catch((error) => {
      if (!proc.stopping) {
        log.error(`[lwk-serve] lwk serve failed to start: ${message(error)}`);
        proc.child.kill("SIGKILL");
      }
    });
    return proc;
  };

  /** The resident process, started (after any backoff) when there is none. */
  const ensure = async (): Promise<Resident> => {
    if (refused) throw refused;
    if (!resident) {
      // A short backoff is waited out; a long one fails the call now
      // rather than hold the caller.
      const wait = notBefore - Date.now();
      if (wait > BACKOFF_WAIT_MAX_MS)
        throw new LwkServeError(
          "unavailable",
          `lwk serve is restarting; try again in ${Math.ceil(wait / 1000)} s.`,
        );
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      if (closed)
        throw new LwkServeError("unavailable", "The app is shutting down.");
      if (refused) throw refused;
      if (current === "per-call")
        throw new LwkServeError("unavailable", "lwk serve is off.");
      resident ??= start();
    }
    const proc = resident;
    await proc.ready;
    return proc;
  };

  const callResident = async (
    method: LwkToolMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LwkAnswer> => {
    const proc = await ensure();
    // The mode changed while it started: go where calls go now.
    if (proc.retiring) return dispatch(method, params, signal);
    if (signal?.aborted)
      throw new LwkServeError("aborted", "The call was aborted.");
    return new Promise((resolveAnswer, rejectAnswer) => {
      const id = nextId++;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (!proc.pending.has(id)) return;
        void control(proc, "cancel", { id }).catch(() => {});
        // lwk answers the call `cancelled`; give up waiting if it does not.
        graceTimer = setTimeout(() => {
          const pending = proc.pending.get(id);
          if (!pending) return;
          proc.pending.delete(id);
          pending.reject(new LwkServeError("cancelled", "Cancelled."));
        }, CANCEL_GRACE_MS);
        graceTimer.unref?.();
      };
      proc.pending.set(id, {
        method,
        params,
        signal,
        resolve: resolveAnswer,
        reject: rejectAnswer,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(graceTimer);
        },
        tool: true,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!send(proc, id, method, params)) {
        proc.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        rejectAnswer(new LwkServeError("unavailable", "lwk is not running."));
      }
    });
  };

  const dispatch = (
    method: LwkToolMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LwkAnswer> => {
    if (closed)
      return Promise.reject(
        new LwkServeError("unavailable", "The app is shutting down."),
      );
    if (!(LWK_TOOL_METHODS as readonly string[]).includes(method))
      return Promise.reject(
        new LwkServeError("invalid", `Unknown method: ${String(method)}`),
      );
    return current === "per-call"
      ? runOnce(binary, method, params, signal, runs)
      : callResident(method, params, signal);
  };

  const setMode = (mode: LwkMode) => {
    if (!LWK_MODES.includes(mode) || closed) return;
    const before = current;
    current = mode;
    if (mode === before) {
      if (mode === "always" && !resident) void ensure().catch(() => {});
      return;
    }
    // A process started for the other resident mode has the wrong idle
    // exit; it finishes its calls and ends, and the next one is started.
    if (resident) retire(resident);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (mode === "always") void ensure().catch(() => {});
  };

  const stop = async (proc: Resident) => {
    proc.stopping = true;
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      void control(proc, "shutdown").catch(() => {});
      const timer = setTimeout(() => proc.child.kill("SIGKILL"), SHUTDOWN_MS);
      await proc.exited;
      clearTimeout(timer);
    }
  };

  const shutdown = async () => {
    closed = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const procs = [...retired, ...(resident ? [resident] : [])];
    resident = null;
    for (const child of runs) child.kill("SIGKILL");
    await Promise.all(procs.map(stop));
  };

  if (current === "always") void ensure().catch(() => {});

  return {
    call: dispatch,
    mode: () => current,
    setMode,
    shutdown,
    pid: () => resident?.child.pid ?? null,
  };
}

// ─── Per-call mode ──────────────────────────────────────────────────────────

/** `lwk`'s CLI command for each tool, and how its `--json` answer maps back. */
const CLI: Record<
  LwkToolMethod,
  { command: string; first?: string; pick?: string }
> = {
  find_files: { command: "find", first: "query", pick: "files" },
  search_text: { command: "grep", first: "query", pick: "matches" },
  search_structural: { command: "sg", first: "pattern", pick: "matches" },
  list_files: { command: "ls" },
  search_sessions: { command: "sessions", first: "query", pick: "sessions" },
};

const isWithinFolder = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
};

const intParam = (params: Record<string, unknown>, name: string) => {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new LwkServeError("invalid", `${name} must be an integer.`);
  return String(value);
};

/** The CLI arguments for one call, params checked as lwk serve would. */
async function cliArgs(
  method: LwkToolMethod,
  params: Record<string, unknown>,
): Promise<{ cwd: string; args: string[] }> {
  const cwd = params.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    throw new LwkServeError("invalid", "cwd must be an absolute path.");
  if (
    typeof params.path === "string" &&
    typeof params.folder === "string" &&
    params.path !== params.folder
  )
    throw new LwkServeError("invalid", "Pass path or folder, not both.");
  const path = params.path ?? params.folder;
  if (path !== undefined && path !== null && typeof path !== "string")
    throw new LwkServeError("invalid", "path must be a string.");

  // `roots` has no CLI flag: check the scope here, as lwk serve would.
  if (params.roots !== undefined && params.roots !== null) {
    const roots = params.roots;
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.length > 32 ||
      !roots.every((root) => typeof root === "string" && isAbsolute(root))
    )
      throw new LwkServeError(
        "invalid",
        "roots must be 1 to 32 absolute folders.",
      );
    const target = await realpath(resolve(cwd, path ?? ".")).catch(() =>
      resolve(cwd, path ?? "."),
    );
    const real = await Promise.all(
      (roots as string[]).map((root) => realpath(root).catch(() => root)),
    );
    if (!real.some((root) => isWithinFolder(root, target)))
      throw new LwkServeError(
        "scope",
        `${path ?? cwd} is outside the allowed folders.`,
      );
  }

  const spec = CLI[method];
  const options: string[] = ["--json"];
  const limit = intParam(params, "limit");
  if (limit) options.push("--limit", limit);
  if (method === "find_files" && params.git === true) options.push("--git");
  if (method === "search_text" || method === "search_structural") {
    const maxLines = intParam(params, "max_lines");
    if (maxLines) options.push("--max-lines", maxLines);
    const globs = params.globs;
    if (globs !== undefined && globs !== null) {
      if (!Array.isArray(globs) || !globs.every((g) => typeof g === "string"))
        throw new LwkServeError("invalid", "globs must be strings.");
      for (const glob of globs) options.push("--glob", glob);
    }
  }
  if (method === "search_text") {
    if (params.regex === true) options.push("--regex");
    if (params.case_sensitive === true) options.push("--case-sensitive");
    else if (params.case_sensitive === false) options.push("--ignore-case");
  }
  if (method === "search_structural" && params.lang !== undefined) {
    if (typeof params.lang !== "string")
      throw new LwkServeError("invalid", "lang must be a string.");
    options.push("--lang", params.lang);
  }

  const positional: string[] = [];
  if (spec.first) {
    const first = params[spec.first];
    if (typeof first !== "string" || first === "")
      throw new LwkServeError("invalid", `${spec.first} is required.`);
    positional.push(first);
  }
  if (typeof path === "string") positional.push(path);
  // `--` keeps a query that starts with `-` a query.
  return { cwd, args: [spec.command, ...options, "--", ...positional] };
}

/** lwk's words on stderr (`lwk grep: …`) as a contract code. */
function cliError(stderr: string): LwkServeError {
  const text =
    stderr
      .trim()
      .split("\n")
      .pop()
      ?.replace(/^lwk(?: \w+)?: /, "") || "lwk failed.";
  const code: LwkErrorCode = /outside|never searched/i.test(text)
    ? "scope"
    : /does not exist|no such/i.test(text)
      ? "not_found"
      : /^usage|not a valid|must be|is a file|not a folder|unknown/i.test(text)
        ? "invalid"
        : /took too long|timed? ?out/i.test(text)
          ? "timeout"
          : /not installed|missing|unavailable/i.test(text)
            ? "unavailable"
            : "internal";
  return new LwkServeError(code, text);
}

/** One `lwk <command> … --json`, nothing left running after it. */
async function runOnce(
  binary: string,
  method: LwkToolMethod,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  runs: Set<ChildProcess>,
): Promise<LwkAnswer> {
  const { cwd, args } = await cliArgs(method, params);
  if (signal?.aborted)
    throw new LwkServeError("aborted", "The call was aborted.");
  return new Promise((resolveAnswer, rejectAnswer) => {
    const child = spawn(binary, args, {
      cwd,
      // lwk ≥ 0.3.0: run the engine here, never ask kit.sock, which is this
      // app and would hand the call straight back (BE-06).
      env: { ...process.env, LWK_NO_SOCKET: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    runs.add(child);
    let out = "";
    let err = "";
    let tooBig = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (out.length + chunk.length > CLI_STDOUT_MAX) {
        tooBig = true;
        child.kill("SIGKILL");
      } else out += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (err.length < 64 * 1024) err += chunk;
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      runs.delete(child);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted)
        return rejectAnswer(new LwkServeError("cancelled", "Cancelled."));
      if (spawnError)
        return rejectAnswer(
          new LwkServeError(
            "unavailable",
            `Unable to run ${binary}: ${(spawnError as Error).message}`,
          ),
        );
      if (tooBig)
        return rejectAnswer(
          new LwkServeError("internal", "lwk's answer was too large."),
        );
      // 0 found, 1 nothing found (both answer JSON), 2 an error.
      if (code !== 0 && code !== 1) return rejectAnswer(cliError(err));
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(out) as Record<string, unknown>;
      } catch {
        return rejectAnswer(cliError(err || "lwk printed no JSON."));
      }
      const spec = CLI[method];
      const result = spec.pick ? json[spec.pick] : json;
      resolveAnswer(
        typeof json.note === "string"
          ? { result, note: json.note }
          : { result },
      );
    });
  });
}

// ─── The app's client ───────────────────────────────────────────────────────

let client: LwkServe | null = null;

/** The app's client, made the first time it is asked for. */
export function lwkServe(): LwkServe {
  client ??= createLwkServe();
  return client;
}

/**
 * Apply Settings → Power saver → Search engine (lwk): call at app start with
 * the saved mode and whenever it changes.
 */
export function setLwkMode(mode: LwkMode): void {
  lwkServe().setMode(mode);
}

/** Run one kit call through the app's client. */
export function callLwk(
  method: LwkToolMethod,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LwkAnswer> {
  return lwkServe().call(method, params, signal);
}

/** Stop `lwk serve` for app quit; nothing is started after it. */
export async function shutdownLwkServe(): Promise<void> {
  await client?.shutdown();
}
