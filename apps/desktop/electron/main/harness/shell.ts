// Run one script in the user's login shell, the way the terminal's agent
// probe does (FE-19), for the harness checks and updates (FE-61).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { defaultShell, type ShellChoice, shellEnv } from "../terminal/sessions";

export interface ShellOptions {
  /** Pin the shell (tests); otherwise `defaultShell()`. */
  shell?: ShellChoice;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  /** Null when it was killed — timed out — or never started. */
  code: number | null;
}

/** Kept of each stream; a chatty `brew upgrade` only needs its end. */
const MAX_BYTES = 256 * 1024;

/**
 * Run `script` in the user's shell, login AND interactive, and collect what
 * it printed.
 *
 * ⚠️ The SHELL, not this process's PATH: an app opened from the Dock has
 * launchd's PATH, and `brew`, `npm` and an aliased `claude` live only in the
 * user's profile (see `createAgentProbe`).
 *
 * ⚠️ stdin is /dev/null, so a prompt — a profile's, `npm`'s, `sudo`'s — reads
 * nothing and moves on instead of waiting forever. Its own process group,
 * killed whole at `timeoutMs`, so a CLI the shell started cannot outlive it.
 * Never throws: a shell that could not start is an empty result.
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
        /* Already exited. */
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
 * What came after the LAST `marker` line in `output`, or null when it never
 * appeared. A profile prints what it likes before the script runs; only what
 * follows the script's own marker is the script's.
 */
export function afterMarker(output: string, marker: string): string | null {
  const at = output.lastIndexOf(marker);
  return at < 0 ? null : output.slice(at + marker.length);
}
