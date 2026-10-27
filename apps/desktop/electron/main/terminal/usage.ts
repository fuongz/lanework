// Claude's and Codex's usage limits for the footer (FE-41, FE-53, FE-74):
// the polling, its timers, and the IPC that reads and refreshes them.
//
// NOTE: Split out of `terminal/index.ts` (FE-82/D2). It needs to know which
// conversations each workspace's listing last answered, which is the
// listing's state, so `registerUsage` is handed that rather than importing
// the module that owns it.
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  type AgentWrite,
  type ClaudeUsage,
  type CodexQuota,
  type CodexResetOutcome,
  type CodexUsage,
  terminalChannels,
} from "../../../shared/terminal";
import { codexHome } from "../agent-home";
import { createAgentCli } from "../conversation/claude-cli";
import { broadcast, handle } from "../ipc";
import { arity, slug } from "../ipc-args";
import { appHomeDir } from "../paths";
import { testAgentHome } from "../test-seams";
import { claudeAuth, claudeAuthOf } from "./agents";
import {
  type ClaudeOAuthOptions,
  createClaudeOAuthUsage,
  readClaudeCredentialFile,
} from "./claude-oauth-usage";
import { CLAUDE_USAGE_FILE, readClaudeQuota } from "./claude-usage";
import {
  codexQuotaOfAppServer,
  consumeCodexResetCredit,
  readCodexAppServerQuota,
} from "./codex-app-server";
import { type CodexDirs, readCodexUsage } from "./codex-usage";

/** What the usage reads need from the terminal's conversation listing. */
export interface UsageListing {
  /** Each listed workspace's conversation keys, as its listing last answered. */
  listed: () => Iterable<[string, Set<string>]>;
  /** One workspace's conversation keys, listing it if it has not been yet. */
  keysOf: (workspace: string) => Promise<Set<string>>;
}

/** Set by {@link registerUsage}; nothing is listed before it. */
let deps: UsageListing | null = null;

/**
 * Where Codex keeps its rollouts and its databases.
 *
 * `$CODEX_HOME`, and `$CODEX_SQLITE_HOME` before it for the databases: the
 * order Codex itself reads them in.
 *
 * Both sit inside the test home when the agent-home test seam is set:
 * a spec's fake goals sit beside its fake rollouts, and every launch points
 * `CODEX_HOME` at a profile folder for the hook (FE-29).
 */
export function codexDirs(): CodexDirs {
  const test = testAgentHome();
  if (test) {
    const dir = join(test, ".codex");
    return { home: dir, sqlite: dir };
  }
  const home = codexHome();
  return { home, sqlite: process.env.CODEX_SQLITE_HOME || home };
}

/** The user's `codex`, for its own archive. */
export const codexCli = createAgentCli("codex", () =>
  !app.isPackaged && process.env.LANEWORK_TEST_USER_DATA
    ? process.env.LANEWORK_CODEX_BIN
    : undefined,
);

// ── Codex limits and banked resets (FE-74) ────────────────────────────────

/** Ask `codex app-server` again in the background after this long. */
const CODEX_SERVER_TTL_MS = 5 * 60_000;
/** The popover opening asks again only past this. */
const CODEX_SERVER_FRESH_MS = 60_000;

/** The last `codex app-server` answer, and when it was asked (epoch ms). */
let codexServer: { quota: CodexQuota | null; at: number } | null = null;
let codexServerReading: Promise<void> | null = null;

/** A test run's stand-ins for Codex, never Codex itself: it is a real account. */
function codexServerSeam(): { limits?: string; outcome?: string } | null {
  if (app.isPackaged || !process.env.LANEWORK_TEST_USER_DATA) return null;
  return {
    limits: process.env.LANEWORK_TEST_CODEX_RATE_LIMITS,
    outcome: process.env.LANEWORK_TEST_CODEX_RESET_OUTCOME,
  };
}

/** The `codex` to run, against the Codex home the rail lists. */
async function codexServerCli() {
  const cli = await codexCli();
  return { file: cli.file, env: { ...cli.env, CODEX_HOME: codexDirs().home } };
}

/**
 * Ask Codex for the account's limits and resets, then tell the pages.
 *
 * A read already running is shared. A failed one keeps the last answer and
 * waits the TTL before trying again: a Codex without the method, or signed
 * out, is not asked on every listing.
 */
function readCodexServer(): Promise<void> {
  codexServerReading ??= (async () => {
    const seam = codexServerSeam();
    try {
      const quota = seam
        ? seam.limits
          ? codexQuotaOfAppServer(
              JSON.parse(seam.limits),
              new Date().toISOString(),
            )
          : null
        : await readCodexAppServerQuota(await codexServerCli());
      codexServer = { quota, at: Date.now() };
    } catch {
      codexServer = { quota: codexServer?.quota ?? null, at: Date.now() };
    }
    notifyClaudeUsage();
  })().finally(() => {
    codexServerReading = null;
  });
  return codexServerReading;
}

/** Ask Codex again when its last answer is older than `maxAge`. */
function refreshCodexServer(maxAge: number): Promise<void> {
  if (codexServer && Date.now() - codexServer.at < maxAge)
    return Promise.resolve();
  return readCodexServer();
}

/**
 * The quota to show: Codex's own answer, unless a turn reported newer
 * windows since. The banked resets only Codex's answer has.
 */
function codexQuotaNow(rollout: CodexQuota | null): CodexQuota | null {
  const server = codexServer?.quota ?? null;
  if (!server) return rollout;
  const windows = Boolean(server.primary || server.secondary);
  if (windows && (!rollout || Date.parse(server.at) >= Date.parse(rollout.at)))
    return server;
  if (!rollout) return server;
  return {
    ...rollout,
    plan: rollout.plan ?? server.plan,
    resetCredits: server.resetCredits ?? null,
    source: "rollout",
  };
}

let lastClaudePlan: string | null | undefined;
let lastClaudeIdentity: string | null | undefined;
let lastClaudeMode: string | undefined;
let claudeAccountChangedAt = 0;
let quotaWatch: FSWatcher | null = null;
/**
 * Tell every listed workspace to ask `codexUsage` again.
 *
 * Sent as an `agentWritten` on one of its Claude conversations, or on a
 * placeholder id when it has none.
 */
function notifyClaudeUsage(): void {
  for (const [workspace, keys] of deps?.listed() ?? []) {
    const id = [...keys].find((key) => key.startsWith("claude:"))?.slice(7);
    broadcast(terminalChannels.agentWritten, {
      workspace,
      agent: "claude",
      id: id ?? "00000000-0000-4000-8000-000000000000",
      at: Date.now(),
    } satisfies AgentWrite);
  }
}
function watchClaudeQuota(): void {
  if (quotaWatch) return;
  try {
    quotaWatch = watch(appHomeDir(), (_event, file) => {
      if (file?.toString() !== CLAUDE_USAGE_FILE) return;
      notifyClaudeUsage();
    });
    quotaWatch.on("error", () => {
      quotaWatch?.close();
      quotaWatch = null;
    });
    quotaWatch.unref();
  } catch {
    // A later read retries once the application home exists.
  }
}

/**
 * Where main reads Claude's OAuth usage from.
 *
 * NOTE: A test seam, guarded the way `LANEWORK_TEST_USER_DATA` is. Under
 * test, the credential comes only from `LANEWORK_TEST_CLAUDE_CREDENTIALS`
 * and goes only to a loopback `LANEWORK_TEST_CLAUDE_OAUTH_URL`, never the
 * Keychain or Anthropic, so a spec can neither prompt for nor spend the
 * developer's own login.
 */
function claudeOAuthOptions(): ClaudeOAuthOptions {
  if (app.isPackaged || !process.env.LANEWORK_TEST_USER_DATA) return {};
  const file = process.env.LANEWORK_TEST_CLAUDE_CREDENTIALS;
  const url = process.env.LANEWORK_TEST_CLAUDE_OAUTH_URL;
  const loopback = Boolean(url && /^http:\/\/127\.0\.0\.1:\d+\//.test(url));
  return {
    url: loopback ? url : "http://127.0.0.1:9/",
    readCredential: async () =>
      file && loopback ? readClaudeCredentialFile(file) : null,
  };
}
let claudeOAuthCache: ReturnType<typeof createClaudeOAuthUsage> | null = null;
function claudeOAuth() {
  claudeOAuthCache ??= createClaudeOAuthUsage(claudeOAuthOptions());
  return claudeOAuthCache;
}
const CLAUDE_USAGE_POLL_MS = 5 * 60_000;
let claudeUsageTimer: NodeJS.Timeout | null = null;
/** Fetch without a renderer asking; tell the renderers when it changed. */
function pollClaudeOAuth(force = false): void {
  const before = claudeOAuth().current();
  void claudeOAuth()
    .read({ force })
    .then((after) => {
      if (after.at !== before.at || after.error !== before.error)
        notifyClaudeUsage();
    })
    .catch(() => undefined);
}
/**
 * Poll Claude's OAuth usage on launch, then every five minutes.
 *
 * The cache sets the floor, so a poll never fetches more often than it
 * allows.
 */
function startClaudeUsagePoll(): void {
  if (claudeUsageTimer) return;
  pollClaudeOAuth();
  claudeUsageTimer = setInterval(() => pollClaudeOAuth(), CLAUDE_USAGE_POLL_MS);
  claudeUsageTimer.unref();
}

/**
 * Claude's limits for the footer.
 *
 * The OAuth endpoint's answer or the last statusline report, whichever is
 * newer. Each is shown only for the account that produced it. A failed
 * fetch keeps the last good windows and says why in `error`.
 *
 * @param force fetch even when the cached answer is fresh.
 */
async function claudeUsageNow(force: boolean): Promise<ClaudeUsage> {
  watchClaudeQuota();
  startClaudeUsagePoll();
  const testAuth =
    !app.isPackaged &&
    process.env.LANEWORK_TEST_USER_DATA &&
    process.env.LANEWORK_TEST_CLAUDE_AUTH;
  const [oauth, quota, auth] = await Promise.all([
    claudeOAuth().read({ force }),
    readClaudeQuota(join(appHomeDir(), CLAUDE_USAGE_FILE)),
    testAuth
      ? Promise.resolve().then(() => {
          try {
            return claudeAuthOf(JSON.parse(testAuth));
          } catch {
            return claudeAuthOf(null);
          }
        })
      : claudeAuth(),
  ]);
  const mode = `${auth.loggedIn}:${auth.authMode}`;
  if (
    (lastClaudePlan !== undefined && lastClaudePlan !== auth.plan) ||
    (lastClaudeIdentity !== undefined &&
      lastClaudeIdentity !== auth.identity) ||
    (lastClaudeMode !== undefined && lastClaudeMode !== mode)
  ) {
    claudeAccountChangedAt = Date.now();
    // The cached answer is the previous account's: fetch the new one's.
    pollClaudeOAuth(true);
  }
  lastClaudePlan = auth.plan;
  lastClaudeIdentity = auth.identity;
  lastClaudeMode = mode;
  const subscription =
    auth.loggedIn &&
    (auth.authMode === "claude.ai" || auth.authMode === "oauth_token");
  const statusline =
    subscription && quota.at && Date.parse(quota.at) > claudeAccountChangedAt
      ? quota
      : null;
  // An API-key login has no subscription limits; an unknown login (the
  // probe failed or timed out) does not hide what the credential answered.
  const oauthAt = oauth.at ? Date.parse(oauth.at) : Number.NaN;
  const fromOAuth = Boolean(
    !(auth.loggedIn && !subscription) &&
      (oauth.primary || oauth.secondary) &&
      oauthAt > claudeAccountChangedAt &&
      (!statusline?.at || oauthAt >= Date.parse(statusline.at)),
  );
  const windows = fromOAuth
    ? {
        primary: oauth.primary,
        secondary: oauth.secondary,
        at: oauth.at,
        stale: Date.now() - oauthAt > 600_000,
      }
    : (statusline ?? {
        primary: null,
        secondary: null,
        at: null,
        stale: false,
      });
  return {
    ...windows,
    plan: auth.plan,
    authMode: auth.authMode,
    source: fromOAuth ? "oauth" : statusline ? "statusline" : null,
    fetchedAt: oauth.fetchedAt,
    // A fresh statusline report answers for the account even when the
    // endpoint could not.
    error: !fromOAuth && statusline && !statusline.stale ? null : oauth.error,
  };
}

/**
 * Register the usage IPC handlers and start polling Claude's limits, so they
 * are known before the footer first asks.
 */
export function registerUsage(
  devUrl: string | undefined,
  listing: UsageListing,
): void {
  deps = listing;
  startClaudeUsagePoll();
  // NOTE: By workspace alone (FE-41): the goals are those of the Codex
  // conversations its own listing last answered, and the quota is the
  // account's. A page names no file and no thread.
  handle(
    terminalChannels.codexUsage,
    devUrl,
    async (args): Promise<CodexUsage> => {
      const [workspace] = arity(args, 1, "A workspace is required");
      const listed = await listing.keysOf(
        slug(workspace, "A valid workspace is required"),
      );
      const ids = [...listed]
        .filter((entry) => entry.startsWith("codex:"))
        .map((entry) => entry.slice("codex:".length));
      const [usage, claude] = await Promise.all([
        readCodexUsage(codexDirs(), ids),
        claudeUsageNow(false),
      ]);
      // In the background: the listing never waits on Codex starting.
      void refreshCodexServer(CODEX_SERVER_TTL_MS);
      return { ...usage, quota: codexQuotaNow(usage.quota), claude };
    },
  );
  // NOTE: A boolean alone (FE-74). The answer is read with `codexUsage`.
  handle(
    terminalChannels.refreshCodexUsage,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 1 || typeof args[0] !== "boolean")
        throw new Error("A boolean is required");
      await (args[0]
        ? readCodexServer()
        : refreshCodexServer(CODEX_SERVER_FRESH_MS));
    },
  );
  // NOTE: Spends a banked reset (FE-74): not undoable, and only ever the id
  // of one Codex listed. The page asks after the user confirms.
  handle(
    terminalChannels.consumeCodexReset,
    devUrl,
    async (args): Promise<CodexResetOutcome> => {
      if (args.length !== 1) throw new Error("A reset id is required");
      const id = args[0];
      const listed = codexServer?.quota?.resetCredits?.credits ?? [];
      if (typeof id !== "string" || !listed.some((credit) => credit.id === id))
        throw new Error("That reset is not one Codex listed.");
      const seam = codexServerSeam();
      const outcome = seam
        ? ((seam.outcome as CodexResetOutcome | undefined) ?? "reset")
        : await consumeCodexResetCredit(await codexServerCli(), id);
      await readCodexServer();
      return outcome;
    },
  );
  // NOTE: No arguments, and only the safe `ClaudeUsage` comes back (FE-53):
  // the credential is read and used inside main, never sent to a renderer.
  handle(
    terminalChannels.refreshClaudeUsage,
    devUrl,
    async (args): Promise<ClaudeUsage | null> => {
      if (args.length !== 0) throw new Error("No arguments are accepted");
      return claudeUsageNow(true);
    },
  );
}
