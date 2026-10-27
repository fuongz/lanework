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
import { join } from "node:path";
import type { HarnessAccount } from "../../../shared/harness";
import { agentHome } from "../agent-home";
import { claudeAuth } from "../terminal/agents";
import { codexAccountOf } from "./codex-account";

async function codexAccount(home: string): Promise<HarnessAccount> {
  const raw = await readFile(
    join(agentHome(home).codexDir, "auth.json"),
    "utf8",
  ).catch(() => null);
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

/**
 * Both CLIs' accounts.
 *
 * @param home The agents' home folder: the caller applies the test seam
 *   (`agentHomeDir()`), so this file needs no Electron.
 */
export function harnessAccounts(home: string): Promise<HarnessAccount[]> {
  return Promise.all([claudeAccount(), codexAccount(home)]);
}
