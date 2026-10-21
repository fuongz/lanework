// Who Claude Code and Codex are signed in as, for Settings › Harness.
//
// NOTE: Labels only (email, organization, plan), read from what each CLI keeps
// for itself, and nothing else of it.
//
// - Claude's come from `claude auth status`, the probe the usage footer
//   already runs.
// - Codex's come from the claims of the `id_token` in its `auth.json`:
//   decoded, never verified, never sent anywhere. The token itself, and every
//   other field of that file, stay here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import type { HarnessAccount } from "../../../shared/harness";
import { agentHome } from "../agent-home";
import { claudeAuth } from "../terminal/agents";
import { codexAccountOf } from "./codex-account";

/** The agent home: the test's fake home in a dev build, else the real one. */
function where() {
  return agentHome(
    (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir(),
  );
}

async function codexAccount(): Promise<HarnessAccount> {
  const raw = await readFile(join(where().codexDir, "auth.json"), "utf8").catch(
    () => null,
  );
  if (raw === null) return codexAccountOf(null);
  try {
    return codexAccountOf(JSON.parse(raw));
  } catch {
    return codexAccountOf(null);
  }
}

async function claudeAccount(): Promise<HarnessAccount> {
  const auth = await claudeAuth();
  return {
    agent: "claude",
    signedIn: auth.loggedIn,
    email: auth.loggedIn ? auth.email : null,
    org: auth.loggedIn ? auth.org : null,
    plan: auth.loggedIn ? auth.plan : null,
  };
}

export function harnessAccounts(): Promise<HarnessAccount[]> {
  return Promise.all([claudeAccount(), codexAccount()]);
}
