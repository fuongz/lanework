// Running the GitHub CLI from the main process.
//
// `gh` owns the GitHub login and makes every request. This app never reads
// its token: it runs subcommands and reads what they print.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { commandPath } from "../harness/rules";
import { runInLoginShell } from "../harness/shell";

/** What went wrong, in the terms a caller branches on. */
export type GitHubErrorKind =
  | "missing"
  | "auth"
  | "not-found"
  | "forbidden"
  | "conflict"
  | "rate-limit"
  | "timeout"
  | "network"
  | "failed";

/** A `gh` failure, already turned into a sentence a person can act on. */
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  constructor(kind: GitHubErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "GitHubError";
  }
}

/** How one `gh` command runs. */
export interface GhOptions {
  /** Where to run. Only `gh repo view` without a repo argument needs it. */
  cwd?: string;
  /** Written to stdin, for `--body-file -`. */
  input?: string;
  /** 30 seconds by default. */
  timeoutMs?: number;
  /** The most stdout kept, in bytes; 16 MB by default. */
  maxBuffer?: number;
}

/** The `gh` binary to run, and the PATH to run it with. */
interface GhCommand {
  file: string;
  /** The login shell's PATH, so `gh` can find `git` the way a terminal does. */
  path: string | null;
}

/** Where `gh` was found; null until the next call looks again. */
let located: Promise<GhCommand> | null = null;

/** Markers that fence each answer in the login shell's output. */
const MARK_PATH = "__lanework_gh_path__";
const MARK_BIN = "__lanework_gh_bin__";
const MARK_END = "__lanework_gh_end__";

/**
 * Find `gh` the way a terminal tab would.
 *
 * - An app opened from the Dock has launchd's short PATH, and Homebrew's
 *   `gh` is not on it. So the user's login shell is asked, like the agent
 *   probe in `terminal/agents.ts` does.
 * - `LANEWORK_GH_PATH` pins the binary, so a test can put a fake `gh` in.
 * - A shell that finds nothing falls back to a bare `gh` on this process's
 *   PATH. If that is missing too, `execFile` fails with ENOENT and the
 *   caller reports `missing`.
 */
async function locate(): Promise<GhCommand> {
  const pinned = process.env.LANEWORK_GH_PATH;
  if (pinned) return { file: pinned, path: null };
  if (process.platform === "win32") return { file: "gh", path: null };

  const line = (marker: string) => `printf '\\n%s\\n' '${marker}'`;
  const script = [
    line(MARK_PATH),
    `printf '%s\\n' "$PATH"`,
    line(MARK_BIN),
    "command -v gh 2>/dev/null",
    line(MARK_END),
  ].join("; ");
  const { stdout } = await runInLoginShell(script, { timeoutMs: 10_000 });

  const between = (from: string, to: string): string | null => {
    const start = stdout.lastIndexOf(from);
    if (start < 0) return null;
    const rest = stdout.slice(start + from.length);
    const end = rest.indexOf(to);
    return (end < 0 ? rest : rest.slice(0, end)).trim();
  };
  const path = between(MARK_PATH, MARK_BIN) || null;
  const found = commandPath(between(MARK_BIN, MARK_END) ?? "", homedir());
  return { file: found ?? "gh", path };
}

/** The `gh` to run, looked for once and then reused. */
function command(): Promise<GhCommand> {
  located ??= locate().catch(() => ({ file: "gh", path: null }));
  return located;
}

/**
 * Look for `gh` again on the next call.
 *
 * Called by the "check again" button and after a `missing` answer, so a
 * `brew install gh` is seen without restarting the app.
 */
export function relocateGh(): void {
  located = null;
}

/**
 * The environment `gh` runs with.
 *
 * - The app's own `LANEWORK_*` and `ELECTRON_*` switches are dropped, so a
 *   `git` that `gh` starts cannot run as Electron or against the app's home.
 * - Every prompt and pager is off. stdin is not a terminal, and a prompt
 *   would hold the command until it timed out.
 */
function env(path: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("LANEWORK_") || key.startsWith("ELECTRON_")) continue;
    out[key] = value;
  }
  if (path) out.PATH = path;
  if (!out.LANG && process.platform === "darwin") out.LANG = "en_US.UTF-8";
  out.GH_PROMPT_DISABLED = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GH_PAGER = "cat";
  out.GIT_PAGER = "cat";
  out.NO_COLOR = "1";
  out.GH_NO_UPDATE_NOTIFIER = "1";
  out.GH_SPINNER_DISABLED = "1";
  return out;
}

/**
 * Until when every `gh` command is refused, in epoch ms.
 *
 * NOTE: Shared by every command. The pull-request screen and the
 * new-PR watcher spend the same hourly budget, and a watcher that kept
 * polling after a rate limit would push the reset further out.
 */
let blockedUntil = 0;

/** How long a rate limit blocks `gh` when GitHub does not say. */
const BACKOFF_MS = 60_000;

/** The longest a rate limit may block, whatever the reset time says. */
const MAX_BACKOFF_MS = 60 * 60_000;

/** Whether `gh`'s stderr says a rate limit was hit. */
function rateLimited(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    (text.includes("api rate limit") && text.includes("exceeded")) ||
    text.includes("secondary rate limit") ||
    text.includes("abuse detection")
  );
}

/** The sentence a blocked command fails with, in minutes left. */
function blockedMessage(): string {
  const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60_000));
  return minutes === 1
    ? "GitHub's request limit is used up. Try again in a minute."
    : `GitHub's request limit is used up. Try again in about ${minutes} minutes.`;
}

/**
 * When the GraphQL budget refills, in epoch ms.
 *
 * Run past the block, since it is what sets the block. The `rateLimit` query
 * costs no points, so it still answers when the budget is spent.
 *
 * @returns null when the budget is not spent or the reset cannot be read.
 */
async function graphqlReset(cmd: GhCommand): Promise<number | null> {
  try {
    const out = await spawnGh(
      cmd,
      [
        "api",
        "graphql",
        "-f",
        "query=query { rateLimit { remaining resetAt } }",
      ],
      { timeoutMs: 10_000 },
    );
    const data = JSON.parse(out) as {
      data?: { rateLimit?: { remaining?: unknown; resetAt?: unknown } };
    };
    const limit = data?.data?.rateLimit;
    if (limit?.remaining !== 0 || typeof limit.resetAt !== "string")
      return null;
    const at = Date.parse(limit.resetAt);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The first meaningful line of stderr, safe to show. */
function firstLine(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line
    .replace(/^gh:\s*/i, "")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 300);
}

/**
 * Turn what `gh` printed into a {@link GitHubError}.
 *
 * NOTE: matched on English text. `gh` has no machine-readable error output,
 * so a reworded message lands in `failed` with its own text, never in a
 * wrong branch.
 */
function classify(stderr: string): GitHubError {
  const text = stderr.toLowerCase();
  // NOTE: Checked first. Offline, `gh auth status` can still mention
  // `gh auth login`, and reading that as signed out sends people to log in
  // again when the fix is their connection.
  if (
    text.includes("error connecting to") ||
    text.includes("dial tcp") ||
    text.includes("no such host") ||
    text.includes("could not resolve host") ||
    text.includes("connection refused") ||
    text.includes("network is unreachable") ||
    text.includes("i/o timeout") ||
    text.includes("tls handshake timeout") ||
    text.includes("timeout trying to log in")
  )
    return new GitHubError(
      "network",
      "GitHub did not answer. Check your connection, then try again.",
    );
  if (
    text.includes("gh auth login") ||
    text.includes("not logged in") ||
    text.includes("bad credentials") ||
    text.includes("(http 401)") ||
    text.includes("authentication required")
  )
    return new GitHubError(
      "auth",
      "The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then check again.",
    );
  if (text.includes("your own pull request"))
    return new GitHubError(
      "forbidden",
      "You cannot approve or request changes on your own pull request. Leave a comment instead.",
    );
  if (
    text.includes("not mergeable") ||
    text.includes("merge conflict") ||
    text.includes("head branch was modified") ||
    text.includes("head commit") ||
    text.includes("base branch policy") ||
    text.includes("(http 405)") ||
    text.includes("(http 409)")
  )
    return new GitHubError(
      "conflict",
      firstLine(stderr) ||
        "GitHub cannot merge this pull request. Refresh it and check its branch rules.",
    );
  if (
    text.includes("could not resolve to") ||
    text.includes("not found") ||
    text.includes("(http 404)") ||
    text.includes("no pull requests found")
  )
    return new GitHubError(
      "not-found",
      "That repository or pull request does not exist, or your GitHub login cannot see it.",
    );
  if (
    text.includes("(http 403)") ||
    text.includes("forbidden") ||
    text.includes("resource not accessible") ||
    text.includes("must have") ||
    text.includes("permission")
  )
    return new GitHubError(
      "forbidden",
      "GitHub refused that request. Your login may not have access to this repository.",
    );
  return new GitHubError(
    "failed",
    firstLine(stderr) || "The GitHub CLI failed. Try again.",
  );
}

/**
 * Run `gh` once, with no rate-limit block.
 *
 * Rejects with a {@link GitHubError} for a missing binary, a too-large
 * answer or a timeout, and otherwise with an error carrying raw `stderr`.
 */
function spawnGh(
  cmd: GhCommand,
  args: string[],
  options: GhOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd.file,
      args,
      {
        cwd: options.cwd ?? homedir(),
        env: env(cmd.path),
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          relocateGh();
          reject(
            new GitHubError(
              "missing",
              "The GitHub CLI (gh) is not installed. Install it, run `gh auth login`, then check again.",
            ),
          );
          return;
        }
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new GitHubError("failed", "GitHub's answer was too large."));
          return;
        }
        if (error.killed) {
          reject(
            new GitHubError(
              "timeout",
              "The GitHub CLI took too long to answer. Check your connection and try again.",
            ),
          );
          return;
        }
        // Raw stderr travels on the error so `gh()` can look for a rate limit
        // before it is turned into a sentence.
        reject(Object.assign(new Error(stderr || error.message), { stderr }));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/**
 * Run `gh <args>` and answer its stdout.
 *
 * - `execFile`, never a shell: every argument stays one argument, whatever
 *   characters it holds.
 * - A rate limit blocks every later call for {@link BACKOFF_MS}. A
 *   subcommand or GraphQL call reads the GraphQL reset time and blocks until
 *   then, at most {@link MAX_BACKOFF_MS}.
 *
 * @throws {@link GitHubError} and nothing else.
 */
export async function gh(
  args: string[],
  options: GhOptions = {},
): Promise<string> {
  if (Date.now() < blockedUntil)
    throw new GitHubError("rate-limit", blockedMessage());
  const cmd = await command();
  try {
    return await spawnGh(cmd, args, options);
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (rateLimited(stderr)) {
      blockedUntil = Date.now() + BACKOFF_MS;
      const rest = args[0] === "api" && args[1] !== "graphql";
      if (!rest) {
        const reset = await graphqlReset(cmd);
        if (reset !== null)
          blockedUntil = Math.min(
            Math.max(blockedUntil, reset),
            Date.now() + MAX_BACKOFF_MS,
          );
      }
      throw new GitHubError("rate-limit", blockedMessage());
    }
    throw classify(stderr);
  }
}

/**
 * Run `gh <args>` and parse its stdout as JSON.
 *
 * @throws {@link GitHubError} when `gh` fails or prints something else.
 */
export async function ghJson(
  args: string[],
  options: GhOptions = {},
): Promise<unknown> {
  const out = await gh(args, options);
  try {
    return JSON.parse(out);
  } catch {
    throw new GitHubError("failed", "The GitHub CLI returned unreadable data.");
  }
}

/** True while a rate limit is blocking every `gh` command. */
export function ghBlocked(): boolean {
  return Date.now() < blockedUntil;
}
