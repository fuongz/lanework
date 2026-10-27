// Where the user's own `claude` (or `codex`) is, for the headless engine
// (FE-62/D1).
//
// Found the way the terminal finds agent CLIs (`terminal/agents.ts`): the
// user's login AND interactive shell is asked, because Claude's installer may
// put `claude` in the profile as an alias no PATH lookup finds. The engine
// then runs the binary with that shell's PATH, so the tools Claude runs find
// what a tab would.
//
// NOTE: The binary runs directly: never through a shell, never a string the
// page sent.
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defaultShell, shellEnv } from "../terminal/shell-env";

/** An agent CLI's binary and the environment to run it with. */
export interface ClaudeCli {
  file: string;
  env: Record<string, string>;
}

/** The CLIs the chat runs. */
type CliName = "claude" | "codex";

/** Fences the probe's answers off from whatever the shell profile prints. */
const MARK = "__lanework_agent_cli__";
/** How long a found CLI is trusted before the shell is asked again. */
const TTL_MS = 5 * 60_000;

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v <name>`'s answer: a path, or an alias whose target is one. */
function cliPath(answer: string, name: CliName = "claude"): string | null {
  const line = answer.trim().split("\n").pop()?.trim() ?? "";
  if (isAbsolute(line)) return line;
  const alias = new RegExp(`^(?:alias\\s+)?${name}=(['"]?)(.+?)\\1$`)
    .exec(line)?.[2]
    ?.trim();
  if (!alias) return null;
  const first = alias.split(/\s+/)[0] ?? "";
  const expanded = first.startsWith("~/")
    ? join(homedir(), first.slice(2))
    : first;
  return isAbsolute(expanded) ? expanded : null;
}

/**
 * Ask the user's login and interactive shell where `name` is, and its PATH.
 *
 * @returns Nulls on Windows, or when the shell fails or takes over 8 seconds.
 */
function probe(
  env: NodeJS.ProcessEnv,
  name: CliName,
): Promise<{ path: string | null; PATH: string | null }> {
  if (process.platform === "win32")
    return Promise.resolve({ path: null, PATH: null });
  const shell = defaultShell(env);
  const script = `printf '%s\\n' '${MARK}'; command -v ${name}; printf '%s\\n' '${MARK}'; printf '%s\\n' "$PATH"`;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(shell.file, [...shell.args, "-i", "-c", script], {
      cwd: homedir(),
      env: shellEnv(env),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    const settle = () => {
      clearTimeout(timer);
      const parts = out.split(`${MARK}\n`);
      // [profile noise, command -v answer, PATH]
      const answer = parts.length >= 3 ? (parts[parts.length - 2] ?? "") : "";
      const PATH = parts.length >= 3 ? (parts.at(-1)?.trim() ?? "") : "";
      resolve({ path: cliPath(answer, name), PATH: PATH || null });
    };
    child.once("error", settle);
    child.once("close", settle);
  });
}

/** Each CLI's own installers' places, when the shell could not say. */
function installed(name: CliName): string[] {
  return name === "claude"
    ? [
        join(homedir(), ".local", "bin", "claude"),
        join(homedir(), ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ]
    : [
        join(homedir(), ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
      ];
}

const MISSING: Record<CliName, string> = {
  claude: "Claude Code is not installed on this Mac.",
  codex: "Codex is not installed on this Mac.",
};

/** The `claude` binary; see {@link createAgentCli}. */
export function createClaudeCli(override?: () => string | undefined) {
  return createAgentCli("claude", override);
}

/**
 * The `name` binary and the environment to run it with, cached a while.
 *
 * The returned function throws when the CLI is not installed.
 *
 * @param override The test seam (`LANEWORK_CLAUDE_BIN` in a test run).
 */
export function createAgentCli(
  name: CliName,
  override?: () => string | undefined,
) {
  let cached: { at: number; cli: ClaudeCli | null } | null = null;
  let running: Promise<ClaudeCli | null> | null = null;
  return async function claudeCli(): Promise<ClaudeCli> {
    const pinned = override?.();
    const base = shellEnv(process.env);
    if (pinned) return { file: pinned, env: base };
    if (cached && Date.now() - cached.at < TTL_MS && cached.cli)
      return cached.cli;
    running ??= (async () => {
      const found = await probe(process.env, name);
      const env = { ...base };
      if (found.PATH) env.PATH = found.PATH;
      const candidates = [found.path, ...installed(name)].filter(
        (entry): entry is string => Boolean(entry),
      );
      for (const file of candidates)
        if (await executable(file)) return { file, env };
      return null;
    })().finally(() => {
      running = null;
    });
    const cli = await running;
    cached = { at: Date.now(), cli };
    if (!cli) throw new Error(MISSING[name]);
    return cli;
  };
}
