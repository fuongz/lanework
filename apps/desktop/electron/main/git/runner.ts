import { execFile } from "node:child_process";

/**
 * The one way the app runs `git` in a user's folder (FE-77, D1).
 *
 * A repository's own `.git` can name programs: `core.fsmonitor`, a clean
 * filter, `gpg.program` for `log.showSignature`, and hooks such as
 * `post-index-change`, which a plain `git status` fires when it refreshes the
 * index. A folder someone cloned and linked would run that code the moment
 * the app reads it. So every call goes through here, with one of two flag
 * sets:
 *
 * - {@link gitRead}, for everything the app does on its own (status, diff,
 *   log, show, ls-files, rev-parse, remote, cat-file, for-each-ref…). No
 *   hooks, no fsmonitor, no signature check, and `--no-optional-locks`, so a
 *   read never rewrites the index and never takes its lock.
 * - {@link gitWrite}, for what the user asked for by name: commit, push,
 *   pull, switch, stage, unstage, discard. The user's own hooks run, as they
 *   would in a terminal. Still no fsmonitor and no signature check.
 *
 * Both carry `--literal-pathspecs`: a file named `*` or `:(top)` is that
 * file, not a pattern. Without it, discarding a file named `*` restores every
 * change in the repository (SX-05). A caller that wants a pattern must not
 * exist; if one ever does, it passes `:(glob)` itself.
 *
 * - `execFile`, never `exec`: there is no shell, so a path with a space, a
 *   quote or a `;` is an argument, not syntax.
 *
 * NOTE: Windows release blocker (SX-02, D10 deferred). `git` is looked up by
 * name with `cwd` set to the repository. On Windows the current directory is
 * searched before PATH, so a `git.exe` committed to the repo would run in
 * place of the real one. Resolve an absolute binary before shipping Windows.
 */

/** The most output one `git` call may produce before it fails. */
export const MAX_OUTPUT = 32 * 1024 * 1024;

/** How long a call may run when the caller names no timeout. */
const DEFAULT_TIMEOUT = 15_000;

/**
 * Flags every call carries.
 *
 * - `core.quotepath=false` returns a non-ASCII filename as itself. Octal
 *   escapes would match neither the path on disk nor the path in the patch.
 * - `color.ui=never` and `--no-pager`, because only a parser reads this
 *   output.
 * - `--literal-pathspecs`: a path is a path, never a glob (SX-05).
 * - `core.fsmonitor=false`: the repository's fsmonitor command never runs.
 * - `log.showSignature=false`: `log` and `show` never start `gpg.program`.
 */
export const BASE_FLAGS: readonly string[] = [
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=never",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "--no-pager",
  "--literal-pathspecs",
];

/**
 * What a read adds to {@link BASE_FLAGS}.
 *
 * - `--no-optional-locks`: `status` does not write the refreshed index back,
 *   so `post-index-change` has nothing to fire on, and a read never fights a
 *   terminal's `git` for `index.lock`.
 * - `core.hooksPath=/dev/null`: no hook runs, even one a read would fire.
 */
export const READ_FLAGS: readonly string[] = [
  ...BASE_FLAGS,
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
];

/**
 * What a user-initiated write carries: {@link BASE_FLAGS} only.
 *
 * The user's hooks (pre-commit, pre-push, merge hooks) run, as in a terminal.
 */
export const WRITE_FLAGS: readonly string[] = BASE_FLAGS;

/** `git` is not on PATH. */
export class GitMissingError extends Error {}

export interface GitResult {
  stdout: string;
  /** 0, or one of the codes the caller listed in `ok`. */
  code: number;
}

export interface GitOptions {
  /** Exit codes besides 0 that are an answer, not a failure. */
  ok?: number[];
  /** Milliseconds; 15 s when unset. */
  timeout?: number;
  /** The whole environment; `process.env` when unset. */
  env?: NodeJS.ProcessEnv;
  /** Bytes of output allowed; {@link MAX_OUTPUT} when unset. */
  maxBuffer?: number;
}

function exec(
  flags: readonly string[],
  cwd: string,
  args: string[],
  options: GitOptions,
): Promise<GitResult> {
  const ok = options.ok ?? [0];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...flags, ...args],
      {
        cwd,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: options.maxBuffer ?? MAX_OUTPUT,
        windowsHide: true,
        encoding: "utf8",
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, code: 0 });
        const code = typeof error.code === "number" ? error.code : null;
        if (error.code === "ENOENT")
          return reject(new GitMissingError("git is not installed."));
        if (code !== null && ok.includes(code))
          return resolve({ stdout, code });
        // git's own words, trimmed to fit a toast. "Author identity unknown"
        // or a pre-commit hook's output is the whole explanation. A generic
        // "commit failed" would send the user to a terminal to find it.
        const said = (stderr || stdout || error.message).trim();
        reject(new Error(said.split("\n").slice(-6).join("\n").slice(0, 800)));
      },
    );
  });
}

/**
 * Run a call the app makes on its own: no hooks, no optional locks.
 *
 * @throws {GitMissingError} When `git` is not installed.
 * @throws {Error} With git's last lines when it exits with a code not in `ok`.
 */
export function gitRead(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return exec(READ_FLAGS, cwd, args, options);
}

/**
 * Run a call the user asked for by name: commit, push, pull, switch, stage,
 * unstage, discard. The repository's hooks run.
 *
 * @throws {GitMissingError} When `git` is not installed.
 * @throws {Error} With git's last lines when it exits with a code not in `ok`.
 */
export function gitWrite(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return exec(WRITE_FLAGS, cwd, args, options);
}

/** {@link gitRead}'s stdout, for a call where only 0 is success. */
export async function gitReadOut(
  cwd: string,
  args: string[],
  options: Omit<GitOptions, "ok"> = {},
): Promise<string> {
  return (await gitRead(cwd, args, options)).stdout;
}

/** {@link gitWrite}'s stdout, for a call where only 0 is success. */
export async function gitWriteOut(
  cwd: string,
  args: string[],
  options: Omit<GitOptions, "ok"> = {},
): Promise<string> {
  return (await gitWrite(cwd, args, options)).stdout;
}
