// The dev-build test seams, spelled once (FE-80, AM-12).
//
// NOTE: A spec points the app at fixtures through `LANEWORK_TEST_*`
// variables. A packaged build must never honour them, or anyone who can set
// an app's environment can point it at another home. Every seam goes through
// `testEnv`, so no caller can forget the `!app.isPackaged` half.
import { homedir } from "node:os";
import { app } from "electron";

/**
 * A `LANEWORK_TEST_*` variable, in a dev build only.
 *
 * @returns undefined in a packaged build, or when it is unset or empty.
 */
export function testEnv(name: `LANEWORK_TEST_${string}`): string | undefined {
  if (app.isPackaged) return undefined;
  return process.env[name] || undefined;
}

/** Whether a spec is driving this dev build (`LANEWORK_TEST_USER_DATA`). */
export function isTestRun(): boolean {
  return testEnv("LANEWORK_TEST_USER_DATA") !== undefined;
}

/**
 * The test's fake agent home (`LANEWORK_TEST_AGENT_HOME`), in a dev build
 * only: where a spec keeps Claude's and Codex's fixtures.
 */
export function testAgentHome(): string | undefined {
  return testEnv("LANEWORK_TEST_AGENT_HOME");
}

/**
 * The home Claude Code and Codex keep their files in: the test's fake one
 * (`testAgentHome`) in a dev build, else the user's.
 */
export function agentHomeDir(): string {
  return testAgentHome() ?? homedir();
}
