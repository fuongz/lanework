// Which version of each agent CLI this machine runs, and where its binary
// really lives (FE-61). Asked of the user's own shell, like FE-19's probe.
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { HarnessAgent } from "../../../shared/harness";
import { commandPath, parseVersion } from "./rules";
import { afterMarker, runInLoginShell, type ShellOptions } from "./shell";

export interface ProbeResult {
  /** The binary's real path, links resolved; null when it is not installed. */
  path: string | null;
  version: string | null;
  /**
   * Whether the shell got to the end of the script. False when it timed out
   * or never started: then "not installed" is a guess, not an answer.
   */
  answered: boolean;
}

export interface ProbeOptions extends Partial<ShellOptions> {
  /**
   * The shell word that runs each CLI: its name by default, a quoted stand-in
   * path in a test run.
   */
  command?: string;
}

const mark = (agent: HarnessAgent, part: string) =>
  `__lanework_harness_${agent}_${part}__`;

/**
 * Ask the user's shell for one CLI: `command -v`, then `--version`.
 *
 * ⚠️ A marker before each answer and one after, never "the output": the
 * profile runs first and may print — or fail on — lines of its own. Each
 * marker is printed on a line of its own, so a profile that left its last
 * line unterminated cannot glue itself to an answer.
 *
 * ⚠️ One shell PER CLI, run side by side: a `--version` that hangs costs only
 * its own answer at the timeout, not the other CLI's.
 *
 * ⚠️ 15 s, not the terminal menu's 8: right after login an interactive
 * profile has been seen to take 10 s on its first run, and nobody is waiting
 * on this answer.
 */
export async function probeAgent(
  agent: HarnessAgent,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  if (process.platform === "win32")
    return { path: null, version: null, answered: true };
  const command = options.command ?? agent;
  const [atPath, atVersion, atEnd] = ["path", "version", "end"].map((part) =>
    mark(agent, part),
  ) as [string, string, string];
  const line = (marker: string) => `printf '\\n%s\\n' '${marker}'`;
  const script = [
    line(atPath),
    `if command -v ${command} 2>/dev/null; then ${line(atVersion)}; ${command} --version </dev/null 2>/dev/null; fi`,
    line(atEnd),
  ].join("; ");
  const { stdout } = await runInLoginShell(script, {
    shell: options.shell,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  const answered = stdout.includes(atEnd);
  const fromPath = afterMarker(stdout, atPath);
  if (fromPath === null) return { path: null, version: null, answered };
  const cut = (text: string, marker: string) => {
    const at = text.indexOf(marker);
    return at < 0 ? text : text.slice(0, at);
  };
  const versionPart = afterMarker(fromPath, atVersion);
  // No version marker: `command -v` found nothing, so it is not installed.
  if (versionPart === null) return { path: null, version: null, answered };
  const found = commandPath(cut(cut(fromPath, atVersion), atEnd), homedir());
  // ⚠️ Resolved here, with every link followed: the install method is read
  // from where the binary lands, not from the PATH entry that links to it.
  const path = found ? await realpath(found).catch(() => found) : null;
  return { path, version: parseVersion(cut(versionPart, atEnd)), answered };
}
