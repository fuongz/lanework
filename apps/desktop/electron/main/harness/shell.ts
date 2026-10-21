// Run one script in the user's login shell, the way the terminal's agent
// probe does, for the harness checks and updates.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { defaultShell, type ShellChoice, shellEnv } from "../terminal/sessions";

export interface ShellOptions {
  /** The shell, pinned by tests. Otherwise {@link defaultShell}. */
  shell?: ShellChoice;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  /** Null when it was killed at the timeout, or never started. */
  code: number | null;
}

/** How much of each stream is kept. A chatty `brew upgrade` needs its end. */
const MAX_BYTES = 256 * 1024;

/**
 * Run `script` in the user's shell, login and interactive, and collect what
 * it printed.
 *
 * Never throws: a shell that could not start is an empty result.
 *
 * - The shell, not this process's PATH: an app opened from the Dock has
 *   launchd's PATH, and `brew`, `npm` and an aliased `claude` live only in
 *   the user's profile (see `createAgentProbe`).
 * - NOTE: stdin is `/dev/null`, so a prompt (a profile's, `npm`'s, `sudo`'s)
 *   reads nothing and moves on instead of waiting forever.
 * - The shell gets its own process group, killed whole at `timeoutMs`, so a
 *   CLI the shell started cannot outlive it.
 */
export function runInLoginShell(
  script: string,
  options: ShellOptions,
): Promise<ShellResult> {
  const env = options.env ?? process.env;
  const shell = options.shell ?? defaultShell(env);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const keep = (text: string) =>
      text.length > MAX_BYTES ? text.slice(-MAX_BYTES) : text;
    const child = spawn(shell.file, [...shell.args, "-i", "-c", script], {
      cwd: homedir(),
      env: shellEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    };
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      kill();
      settle(null);
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = keep(stdout + chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = keep(stderr + chunk);
    });
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code));
  });
}

/**
 * What came after the last `marker` line in `output`.
 *
 * A profile prints what it likes before the script runs. Only what follows
 * the script's own marker belongs to the script.
 *
 * @returns Null when the marker never appeared.
 */
export function afterMarker(output: string, marker: string): string | null {
  const at = output.lastIndexOf(marker);
  return at < 0 ? null : output.slice(at + marker.length);
}
