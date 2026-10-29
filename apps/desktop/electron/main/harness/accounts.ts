// Who Claude Code, Codex and OpenCode are signed in as, for Settings › Harness.
//
// NOTE: Labels only (email, organization, plan), read from what each CLI keeps
// for itself, and nothing else of it.
//
// - Claude's come from `claude auth status`, the probe the usage footer
//   already runs.
// - Codex's come from the claims of the `id_token` in its `auth.json`:
//   decoded, never verified, never sent anywhere. The token itself, and every
//   other field of that file, stay here.
// - OpenCode's: the email and organization OpenCode stored with the account
//   the user signed in with (`opencode.db`'s `credential` row's metadata;
//   its tokens are parsed past, never kept or returned), else whether its
//   `auth.json` holds any key, by name. The plan is Go when OpenCode's
//   service reports Go limits for it (FE-105).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAccount } from "../../../shared/harness";
import { agentHome } from "../agent-home";
import { claudeAuth } from "../terminal/agents";
import { opencodeDataDir, withOpencodeDb } from "../terminal/opencode-sessions";
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

/** The signed-in account OpenCode stored, by its labels; null for none. */
async function opencodeSignIn(
  dataDir: string,
): Promise<{ email: string | null; org: string | null } | null> {
  return withOpencodeDb(dataDir, null, (db) => {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'",
      )
      .get();
    if (!table) return null;
    const row = db
      .prepare(
        `SELECT value FROM credential
          WHERE integration_id = 'opencode' AND (active IS NULL OR active = 1)
          ORDER BY time_updated DESC LIMIT 1`,
      )
      .get() as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return null;
    try {
      const meta = (
        JSON.parse(row.value) as { metadata?: Record<string, unknown> }
      ).metadata;
      const label = (value: unknown) =>
        typeof value === "string" && value.trim()
          ? value.trim().slice(0, 200)
          : null;
      return { email: label(meta?.email), org: label(meta?.orgName) };
    } catch {
      return null;
    }
  });
}

async function opencodeAccount(
  home: string,
  realHome: boolean,
  goPlan: () => Promise<boolean>,
): Promise<HarnessAccount> {
  const dataDir = opencodeDataDir(home, process.env, realHome);
  const [signIn, go] = await Promise.all([
    opencodeSignIn(dataDir).catch(() => null),
    goPlan().catch(() => false),
  ]);
  if (signIn)
    return {
      agent: "opencode",
      signedIn: true,
      email: signIn.email,
      org: signIn.org,
      plan: go ? "Go" : null,
    };
  // `$OPENCODE_AUTH_CONTENT` stands in for the file when it is set, as
  // OpenCode reads it; only the real home's environment counts.
  const blob = realHome ? process.env.OPENCODE_AUTH_CONTENT?.trim() : "";
  const raw =
    blob ||
    (await readFile(join(dataDir, "auth.json"), "utf8").catch(() => null));
  let signedIn = false;
  let plan: string | null = null;
  try {
    const auth: unknown = raw ? JSON.parse(raw) : null;
    signedIn =
      !!auth && typeof auth === "object" && Object.keys(auth).length > 0;
    // A Go key (FE-104/D10): the one plan whose name it tells. Its name,
    // never its value.
    if (go || (signedIn && "opencode-go" in (auth as object))) plan = "Go";
  } catch {
    // Not JSON: no credential OpenCode could use either.
  }
  return { agent: "opencode", signedIn, email: null, org: null, plan };
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
 * Every CLI's account.
 *
 * @param home The agents' home folder: the caller applies the test seam
 *   (`agentHomeDir()`), so this file needs no Electron.
 * @param opencodeGo Whether OpenCode reports Go limits for its account.
 */
export function harnessAccounts(
  home: string,
  opencodeGo: () => Promise<boolean> = async () => false,
): Promise<HarnessAccount[]> {
  return Promise.all([
    claudeAccount(),
    codexAccount(home),
    opencodeAccount(home, home === homedir(), opencodeGo),
  ]);
}
