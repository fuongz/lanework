// The user's `opencode`, for what only its CLI may do to its database: delete
// a session (FE-104/D11).
//
// NOTE: OpenCode's database is OpenCode's. Lanework reads it read-only and
// asks the CLI for every write, the way Codex's own archive goes through
// `codex`.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isTestRun } from "../test-seams";
import { defaultShell, shellEnv } from "./shell-env";

/** How long a found `opencode` is trusted before the shell is asked again. */
const TTL_MS = 5 * 60_000;
/** Fences the probe's answer off from whatever the shell profile prints. */
const MARK = "__lanework_opencode_cli__";

interface OpencodeCli {
  file: string;
  env: Record<string, string>;
}

let cached: { at: number; cli: OpencodeCli | null } | null = null;

/** Where OpenCode's installers put it, when the shell does not say. */
function installed(): string[] {
  return [
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
    join(homedir(), ".bun", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
}

async function executable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** `command -v opencode` in the user's login shell, or null. */
function probe(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = defaultShell(process.env);
  const script = `printf '%s\\n' '${MARK}'; command -v opencode`;
  return new Promise((resolve) => {
    execFile(
      shell.file,
      [...shell.args, "-c", script],
      { env: shellEnv(process.env), timeout: 10_000 },
      (_error, stdout) => {
        const after = String(stdout).split(MARK).pop() ?? "";
        const line = after.trim().split("\n").pop()?.trim() ?? "";
        resolve(isAbsolute(line) ? line : null);
      },
    );
  });
}

/**
 * The `opencode` to run.
 *
 * NOTE: A test run (`LANEWORK_TEST_USER_DATA`, dev build only) runs ONLY the
 * stand-in `LANEWORK_OPENCODE_BIN` names, and refuses without one: the
 * machine's `opencode` would delete from the developer's own sessions.
 *
 * @throws when OpenCode is not installed, or a test run names no stand-in.
 */
async function opencodeCli(): Promise<OpencodeCli> {
  const base = shellEnv(process.env);
  if (isTestRun()) {
    // `isTestRun` is false in a packaged build: the seam is a dev build's.
    const pinned = process.env.LANEWORK_OPENCODE_BIN;
    if (!pinned) throw new Error("OpenCode is not available in a test run.");
    return { file: pinned, env: base };
  }
  if (cached && Date.now() - cached.at < TTL_MS && cached.cli)
    return cached.cli;
  let cli: OpencodeCli | null = null;
  for (const file of [await probe(), ...installed()]) {
    if (!file || !(await executable(file))) continue;
    // Its own folder first on PATH: a script install may run a sibling.
    cli = {
      file,
      env: {
        ...base,
        PATH: [dirname(file), base.PATH].filter(Boolean).join(":"),
      },
    };
    break;
  }
  cached = { at: Date.now(), cli };
  if (!cli) throw new Error("OpenCode is not installed on this Mac.");
  return cli;
}

/**
 * Run `opencode <args>`.
 *
 * NOTE: `execFile`, no shell: the only arguments are a subcommand and an id
 * that passed `isAgentSessionIdOf("opencode", …)`.
 *
 * @throws the last line OpenCode printed, when it fails.
 */
export async function runOpencode(args: string[]): Promise<void> {
  const cli = await opencodeCli();
  await new Promise<void>((resolve, reject) => {
    execFile(
      cli.file,
      args,
      { cwd: homedir(), env: cli.env, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve();
        const said = `${stderr}\n${stdout}`.trim().split("\n").pop()?.trim();
        reject(new Error(said || `opencode ${args[0]} failed.`));
      },
    );
  });
}
