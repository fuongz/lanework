// Where the bundled ripgrep is, and running it with a limit (FE-149).
//
// Nothing in fs-kit imports Electron: the offline MCP server, which runs
// under ELECTRON_RUN_AS_NODE, imports it too.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

/** ripgrep is not where it should be. */
export class RipgrepMissingError extends Error {}

/** A search ran past its time limit. */
export class FsSearchTimeoutError extends Error {}

let cached: string | null = null;

/**
 * The bundled `rg` for this CPU.
 *
 * `scripts/fetch-ripgrep.mjs` stages it as `dist/electron/bin/rg-<arch>`,
 * one level above every bundle (`main/`, `mcp-local/`, `hook/`, `control/`).
 * Packaged, `electron-builder.yml` unpacks `dist/electron/bin/**`, because
 * an executable inside the asar archive cannot be spawned. Unpackaged and
 * never built (a dev run straight after install), it is the copy bun put in
 * node_modules.
 *
 * NOTE: Never an `rg` on PATH: what runs is the version this build pinned.
 *
 * @throws {RipgrepMissingError} When neither copy exists.
 */
export function rgPath(): string {
  if (cached) return cached;
  const exe = process.platform === "win32" ? ".exe" : "";
  // A bundle already run from app.asar.unpacked (the MCP server, the hook)
  // has no `app.asar/` in its path, and is left as it is.
  const bundled = join(
    __dirname,
    "..",
    "bin",
    `rg-${process.arch}${exe}`,
  ).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  if (existsSync(bundled)) {
    cached = bundled;
    return cached;
  }
  const dev = devRgPath();
  if (dev) {
    cached = dev;
    return cached;
  }
  throw new RipgrepMissingError(
    "ripgrep is missing from this build. Run `bun run build` in apps/desktop.",
  );
}

/** node_modules' copy, through @vscode/ripgrep, where bun links it. */
function devRgPath(): string | null {
  // NOTE: The names are built at run time so esbuild leaves them alone: a
  // release bundle has no node_modules and never reaches this.
  const name = ["@vscode", "ripgrep"].join("/");
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const entry = realpathSync(createRequire(__filename).resolve(name));
    const found = createRequire(entry).resolve(
      `${name}-${process.platform}-${process.arch}/bin/${exe}`,
    );
    return existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

export interface RunRgOptions {
  cwd: string;
  /** Milliseconds before the child is killed. */
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Each complete stdout line, without its newline. Returning `false` stops
   * the search: the child is killed and the run resolves normally.
   */
  onLine: (line: string) => boolean | undefined;
}

export interface RunRgResult {
  /** The caller's `onLine` stopped it. */
  stopped: boolean;
  /** It ran out of time; what was read before is kept. */
  timedOut: boolean;
}

/**
 * Run `rg` with `args` in `cwd`, streaming stdout line by line.
 *
 * The child is killed on timeout, on abort and when `onLine` returns
 * false, so no `rg` outlives its search. Exit codes 0 (matches), 1 (none) and
 * 2 (some path could not be read, e.g. a permission error) are all answers.
 *
 * @throws {RipgrepMissingError} When `rg` is missing.
 * @throws The signal's reason when aborted.
 */
export function runRg(
  args: string[],
  options: RunRgOptions,
): Promise<RunRgResult> {
  const bin = rgPath();
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortReason(options.signal));
    let child: ChildProcess;
    try {
      // `--no-require-git`: a folder that is not a repo still has its
      // `.gitignore` honoured; rg reads it only inside one by default.
      child = spawn(bin, ["--no-config", "--no-require-git", ...args], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return reject(error);
    }
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let rest: string[] = [];
    let stderr = "";
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      kill();
      if (error !== undefined) reject(error);
      else resolve({ stopped, timedOut });
    };
    const onAbort = () => finish(abortReason(options.signal));
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    // NOTE: A partial line is kept as pieces and joined once its newline
    // arrives. Prepending it to every chunk and searching again from the
    // start is quadratic, and one match line in a minified bundle or an
    // NDJSON fixture is megabytes of JSON.
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      let start = 0;
      for (;;) {
        const end = chunk.indexOf("\n", start);
        if (end === -1) break;
        let line = chunk.slice(start, end);
        if (rest.length > 0) {
          rest.push(line);
          line = rest.join("");
          rest = [];
        }
        start = end + 1;
        if (line && options.onLine(line) === false) {
          stopped = true;
          return finish();
        }
      }
      if (start < chunk.length) rest.push(chunk.slice(start));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT"
          ? new RipgrepMissingError(`ripgrep could not be started: ${bin}`)
          : error,
      ),
    );
    child.once("close", (code) => {
      if (settled) return;
      const last = rest.join("");
      if (last && options.onLine(last) === false) stopped = true;
      // NOTE: 2 is also "some path could not be read", which still answers.
      // A pattern or glob rg cannot parse exits 2 too, with nothing read:
      // that one is the person's to fix, so it is said, not an empty list.
      if (
        code === 2 &&
        !stopped &&
        /regex parse error|error parsing glob/i.test(stderr)
      )
        return finish(
          new Error(
            `Not a valid ${/glob/i.test(stderr) ? "file filter" : "regular expression"}: ${
              /error: (.+)/.exec(stderr)?.[1]?.trim() ?? "rg could not read it"
            }.`,
          ),
        );
      if (code === 0 || code === 1 || code === 2 || stopped) return finish();
      finish(
        new Error(
          stderr.trim().split("\n").slice(-3).join("\n") ||
            `rg exited with ${code}`,
        ),
      );
    });
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ?? new DOMException("The search was aborted.", "AbortError")
  );
}
