// The main process's side of the terminal: starting the pty host, answering
// the panel's requests, and handing windows a port to it.
import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import {
  type AgentFacts,
  type AgentFileMarks,
  type AgentFiles,
  type AgentSession,
  type AgentUsage,
  type AgentWrite,
  type ArchivedAgentSession,
  type BackgroundTask,
  type BackgroundTaskOutput,
  type CardBrief,
  type ClaudeUsage,
  type CodexQuota,
  type CodexResetOutcome,
  type CodexUsage,
  clampGeometry,
  isAgentSessionId,
  isBoardId,
  isCardBrief,
  isTerminalKind,
  type ListeningPort,
  type SubagentTranscript,
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalCommand,
  type TerminalSession,
  terminalChannels,
} from "../../../shared/terminal";
import { codexHome } from "../agent-home";
import { createAgentCli } from "../conversation/claude-cli";
import { assertTrustedSender, broadcast, handle } from "../ipc";
import { appHomeDir } from "../paths";
import { agentHomeDir, testAgentHome } from "../test-seams";
import {
  authorizedRecord,
  knownWorkspace,
  menuBarWorkspaces,
  projectFolders,
  terminalFolder,
} from "../workspaces";
import { watchAgentActivity } from "./agent-activity";
import {
  archiveAgentTranscript,
  deleteArchivedTranscript,
  listArchivedAgentSessions,
  unarchiveAgentTranscript,
} from "./agent-archive";
import { agentBindings } from "./agent-binding";
import { deleteAgentTranscript } from "./agent-delete";
import { factsRequest, readAgentFacts, readAgentUsage } from "./agent-facts";
import {
  agentFileMarks,
  agentFilesRequest,
  readAgentFiles,
} from "./agent-files";
import {
  applyAgentMarks,
  cleanAgentName,
  keptKeys,
  readAgentMarks,
  updateAgentMark,
} from "./agent-marks";
import { notifyAgentCompleted } from "./agent-notifications";
import { agentKey, listAgentSessions } from "./agent-sessions";
import { claudeAuth, claudeAuthOf } from "./agents";
import {
  backgroundRequest,
  readBackgroundTasks,
  readBackgroundTasksWithPids,
  readTaskOutput,
  stopBackgroundTask,
  taskOutputRequest,
} from "./background-tasks";
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
import { listPorts, stopPort } from "./ports";
import { readSubagentTranscript, subagentRequest } from "./subagent-transcript";

let host: UtilityProcess | null = null;
/**
 * The argument an unpackaged build forks the pty host with. `host.ts` spells
 * the same string: it cannot import this module, which is main-only.
 */
const UNPACKAGED_HOST_ARG = "--lanework-unpackaged";
let nextRequest = 1;
const runningListeners = new Set<() => void>();
export function onRunningChanged(listener: () => void): () => void {
  runningListeners.add(listener);
  return () => {
    runningListeners.delete(listener);
  };
}
const waiting = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

/**
 * The pty host, started on first use.
 *
 * Lazy because most sessions of this app never open a terminal, and a
 * utility process holding a native module costs memory nobody asked for.
 */
function ensureHost(): UtilityProcess {
  if (host) return host;
  // INF-05 (SW-06): the host cannot ask `app.isPackaged` itself, so main
  // tells it. Only an unpackaged host honours the test seams.
  const args = app.isPackaged ? [] : [UNPACKAGED_HOST_ARG];
  const child = utilityProcess.fork(join(__dirname, "pty-host.cjs"), args, {
    serviceName: "Lanework Terminal",
    stdio: "inherit",
  });
  child.on("message", (message: unknown) => {
    const reply = message as {
      t?: string;
      reqId?: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
    } | null;
    if (reply?.t === "changed") {
      for (const listener of runningListeners) listener();
      return;
    }
    if (reply?.t !== "reply" || typeof reply.reqId !== "number") return;
    const entry = waiting.get(reply.reqId);
    if (!entry) return;
    waiting.delete(reply.reqId);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(new Error(reply.error ?? "The terminal failed"));
  });
  child.on("exit", () => {
    if (host === child) host = null;
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("The terminal host stopped."));
    }
    waiting.clear();
    // Every window's port died with it; they reconnect on the next use.
    broadcast(terminalChannels.hostExited, null);
    for (const listener of runningListeners) listener();
  });
  host = child;
  watchMoves();
  return child;
}

function request<T>(
  message: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  const child = ensureHost();
  const reqId = nextRequest++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(reqId);
      reject(new Error("The terminal host did not answer."));
    }, timeoutMs);
    waiting.set(reqId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    child.postMessage({ ...message, reqId });
  });
}

/** A workspace key or session id off the wire. */
function key(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`A valid ${what} is required`);
  return value;
}

/**
 * The card a new agent tab is for, with the board it is on (FE-34/D3).
 *
 * NOTE: The board is the WORKSPACE's own id, looked up here, never one the
 * renderer names. A page can only start an agent on the board of the project
 * it is already allowed to open a terminal for.
 *
 * @throws when the card is malformed or the project has no board.
 */
async function cardFor(
  workspace: string,
  value: unknown,
): Promise<CardBrief & { boardId: string }> {
  if (!isCardBrief(value)) throw new Error("Unknown card");
  const { workspace: known } = await knownWorkspace(workspace);
  if (!isBoardId(known.id))
    throw new Error("This project has no board to take a card from.");
  return { boardId: known.id, card: value.card, mode: value.mode };
}

/**
 * Where Claude and Codex keep their conversations: the user's home.
 *
 * NOTE: A test seam, guarded the way `LANEWORK_TEST_USER_DATA` is: a spec
 * points it at fixtures instead of reading the developer's own history.
 */
function agentHome(): string {
  return agentHomeDir();
}

/**
 * Where Codex keeps its rollouts and its databases.
 *
 * `$CODEX_HOME`, and `$CODEX_SQLITE_HOME` before it for the databases: the
 * order Codex itself reads them in.
 *
 * Both sit inside the test home when the seam of {@link agentHome} is set:
 * a spec's fake goals sit beside its fake rollouts, and every launch points
 * `CODEX_HOME` at a profile folder for the hook (FE-29).
 */
function codexDirs(): CodexDirs {
  const test = testAgentHome();
  if (test) {
    const dir = join(test, ".codex");
    return { home: dir, sqlite: dir };
  }
  const home = codexHome();
  return { home, sqlite: process.env.CODEX_SQLITE_HOME || home };
}

/** The user's `codex`, for its own archive. */
const codexCli = createAgentCli("codex", () =>
  !app.isPackaged && process.env.LANEWORK_TEST_USER_DATA
    ? process.env.LANEWORK_CODEX_BIN
    : undefined,
);

/**
 * Run `codex <args>` against the Codex home the rail lists.
 *
 * NOTE: `execFile`, no shell: the only arguments are a subcommand and an id
 * that passed {@link isAgentSessionId}.
 *
 * @throws the last line Codex printed, when it fails.
 */
async function runCodex(args: string[]): Promise<void> {
  const cli = await codexCli();
  await new Promise<void>((resolve, reject) => {
    execFile(
      cli.file,
      args,
      {
        cwd: homedir(),
        env: { ...cli.env, CODEX_HOME: codexDirs().home },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve();
        const said = `${stderr}\n${stdout}`.trim().split("\n").pop()?.trim();
        reject(new Error(said || `codex ${args[0]} failed.`));
      },
    );
  });
}

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

/** The file of Lanework's names and pins for agent conversations. */
function agentMarksFile(): string {
  return join(appHomeDir(), "agent-sessions.json");
}

/**
 * One transcript watcher per workspace that has been listed, restarted when
 * its folder changes (FE-25/D3).
 *
 * Started by the LISTING, not by a subscribe call: the rail lists a project
 * as soon as it shows it, which is when its rows need to be able to spin.
 * Capped at {@link WATCH_LIMIT}, because every project somebody has looked
 * at in this run would otherwise keep a watcher.
 */
const watching = new Map<string, { folder: string; stop: () => void }>();
const WATCH_LIMIT = 8;

function watchWorkspace(workspace: string, folder: string): void {
  const current = watching.get(workspace);
  if (current?.folder === folder) return;
  current?.stop();
  watching.delete(workspace);
  if (watching.size >= WATCH_LIMIT) {
    const [oldest] = watching.keys();
    if (oldest !== undefined) {
      watching.get(oldest)?.stop();
      watching.delete(oldest);
    }
  }
  const stop = watchAgentActivity(
    agentHome(),
    folder,
    (agent, id, working, card, subagent) =>
      broadcast(terminalChannels.agentActivity, {
        workspace,
        agent,
        id,
        working,
        card,
        subagent,
        at: Date.now(),
      }),
    // NOTE: EVERY write, not only a turn that changed state: a new Codex's
    // first rollout can be caught before its `session_meta` is whole, and
    // the next writes of that turn are no news (FE-31/D5).
    (agent, id) => {
      rebind(workspace, agentKey({ agent, id }));
      // Also for a view showing its numbers, which move on every write of a
      // turn, most of which change no state.
      broadcast(terminalChannels.agentWritten, {
        workspace,
        agent,
        id,
        at: Date.now(),
      } satisfies AgentWrite);
    },
    (agent, id) => {
      void knownWorkspace(workspace)
        .then(async ({ workspace: project }) => {
          const tabs = host
            ? await agentTerminals(workspace).catch((): TerminalSession[] => [])
            : [];
          const tab = tabs.find(
            (entry) =>
              entry.kind === agent && !entry.exit && entry.resume === id,
          );
          // A workspace removed or rebound since must not deliver a late
          // notification.
          if (watching.get(workspace)?.folder === folder)
            notifyAgentCompleted(agent, project, id, tab?.id ?? null);
        })
        .catch(() => {});
    },
  );
  watching.set(workspace, { folder, stop });
}

/**
 * The conversations `workspace`'s folder has, with Lanework's names and pins
 * laid over them; none without a folder here.
 */
async function agentSessionsOf(workspace: string): Promise<AgentSession[]> {
  const folder = await terminalFolder(workspace);
  if (!folder) return [];
  watchWorkspace(workspace, folder);
  const marks = await readAgentMarks(agentMarksFile());
  const listed = await listAgentSessions(agentHome(), folder, keptKeys(marks));
  listedKeys.set(workspace, new Set(listed.map(agentKey)));
  return applyAgentMarks(listed, marks);
}

/** Per workspace with a re-check in flight: the keys written meanwhile. */
const rebinding = new Map<string, Set<string>>();
/**
 * Re-check which conversation `workspace`'s agent tabs are on (FE-31/D5).
 *
 * The host tells every window if one moved. One run at a time per
 * workspace, and at most one more queued behind it: a turn writes its
 * transcript many times a second.
 *
 * @param written the agent key of the transcript just written, if any.
 */
function rebind(workspace: string, written?: string): void {
  if (!host) return;
  const queued = rebinding.get(workspace);
  if (queued) {
    // "" is a run asked for with no write behind it (a Claude move).
    queued.add(written ?? "");
    return;
  }
  const writes = new Set(written ? [written] : []);
  // The next run's writes collect here while this one is in flight.
  rebinding.set(workspace, new Set());
  void agentTerminals(workspace)
    .then((terminals) => {
      // NOTE: A tab on a conversation the rail has not been shown, whose
      // transcript was just written: list again. A new Codex's first write
      // is its `session_meta`, before the prompt that titles it, and the
      // rest of that turn is no news to the activity watcher. Without this
      // its row stays "New Codex session" until something else moves.
      const shown = listedKeys.get(workspace);
      const untitled = terminals.some((entry) => {
        if (entry.kind === "shell" || entry.exit || entry.resume === null)
          return false;
        const key = agentKey({ agent: entry.kind, id: entry.resume });
        return writes.has(key) && !shown?.has(key);
      });
      if (untitled) return request({ t: "touch", workspace });
    })
    .catch(() => undefined)
    .finally(() => {
      const next = rebinding.get(workspace);
      rebinding.delete(workspace);
      // One run for all that queued: the first starts it, the rest join.
      for (const key of next ?? []) rebind(workspace, key || undefined);
    });
}

/** The conversations each workspace's listing last answered, as keys. */
const listedKeys = new Map<string, Set<string>>();
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
  for (const [workspace, keys] of listedKeys) {
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

let movesWatch: FSWatcher | null = null;
let movesTimer: NodeJS.Timeout | null = null;
/**
 * Watch Claude's own record of which conversation each of its processes is
 * on, and re-check every listed workspace when it changes.
 *
 * `/resume` moves a tab by changing only that record, writing nothing to
 * any transcript. Started once the host runs.
 */
function watchMoves(): void {
  if (movesWatch) return;
  try {
    movesWatch = watch(join(agentHome(), ".claude", "sessions"), () => {
      if (movesTimer) return;
      movesTimer = setTimeout(() => {
        movesTimer = null;
        for (const workspace of watching.keys()) rebind(workspace);
      }, 300);
    });
    movesWatch.on("error", () => {
      movesWatch?.close();
      movesWatch = null;
    });
  } catch {
    // No Claude on this machine, or it has never run: nothing to follow.
  }
}

/** The pty pids of `workspace`'s open terminals; none before any started. */
async function liveTerminalPids(workspace: string): Promise<number[]> {
  if (!host) return [];
  const listed = await request<TerminalSession[]>({ t: "list", workspace });
  return listed.filter((entry) => !entry.exit).map((entry) => entry.pid);
}

/**
 * `workspace`'s tabs, each agent tab on the conversation it is on NOW.
 *
 * A tab that moved is moved in the host too, which tells every window, so
 * the rail regroups without polling (FE-31/D5). Best effort: a folder that
 * cannot be read keeps what the host had.
 */
async function agentTerminals(workspace: string): Promise<TerminalSession[]> {
  const listed = await request<TerminalSession[]>({ t: "list", workspace });
  if (!listed.some((entry) => entry.kind !== "shell" && !entry.exit))
    return listed;
  const folder = await terminalFolder(workspace);
  if (!folder) return listed;
  const bindings = await agentBindings(agentHome(), folder, listed).catch(
    () => [],
  );
  if (bindings.length === 0) return listed;
  await request({ t: "bind", workspace, bindings });
  const moved = new Map(bindings.map((entry) => [entry.id, entry.resume]));
  return listed.map((entry) => ({
    ...entry,
    resume: moved.get(entry.id) ?? entry.resume,
  }));
}

/**
 * The conversation a rename or pin names, checked against the listing.
 *
 * NOTE: The same rule a resume follows: an id this workspace's own listing
 * does not have is refused, so nothing can be written about a conversation
 * the rail was never shown.
 *
 * @throws when the arguments are malformed or the id is not listed here.
 */
async function markable(args: unknown[]): Promise<{
  workspace: string;
  key: string;
}> {
  const workspace = key(args[0], "workspace");
  const agent = args[1];
  const id = args[2];
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  const known = await agentSessionsOf(workspace);
  if (!known.some((entry) => entry.agent === agent && entry.id === id))
    throw new Error("That conversation is not one of this project's");
  return { workspace, key: agentKey({ agent, id }) };
}

/** The workspace's archived conversations, with Lanework's names. */
async function archivedOf(workspace: string): Promise<ArchivedAgentSession[]> {
  const folder = await terminalFolder(workspace);
  if (!folder) return [];
  const [archived, marks] = await Promise.all([
    listArchivedAgentSessions(agentHome(), folder),
    readAgentMarks(agentMarksFile()),
  ]);
  return archived.map((entry) => ({
    ...entry,
    title: marks[agentKey(entry)]?.name ?? entry.title,
  }));
}

/**
 * The archived conversation an unarchive or a delete names.
 *
 * Checked against the workspace's archived list: {@link markable}'s rule, for
 * the archive.
 *
 * @throws when the arguments are malformed or the id is not archived here.
 */
async function archivedOne(args: unknown[]): Promise<{
  workspace: string;
  folder: string;
  agent: TerminalAgent;
  id: string;
}> {
  if (args.length !== 3)
    throw new Error("A workspace and a conversation are required");
  const workspace = key(args[0], "workspace");
  const agent = args[1];
  const id = args[2];
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  const folder = await terminalFolder(workspace);
  if (!folder) throw new Error("This project has no folder here.");
  const archived = await listArchivedAgentSessions(agentHome(), folder);
  if (!archived.some((entry) => entry.agent === agent && entry.id === id))
    throw new Error("That conversation is not in this project's archive");
  return { workspace, folder, agent, id };
}

/** Tell the focused window the View menu asked for something. */
export function sendTerminalCommand(command: TerminalCommand): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  const send = () => window.webContents.send(terminalChannels.command, command);
  if (window.webContents.isLoadingMainFrame())
    window.webContents.once("did-finish-load", send);
  else send();
}

interface RunningProject {
  name: string;
  workspace: string;
  slug: string;
  items: { label: string; href: string; shellId?: string }[];
}

/**
 * What runs in every project of the account, for the native menu.
 *
 * Reads the host only when it already runs: it never starts the pty host.
 *
 * @throws when the session changed while the projects were read.
 */
export async function runningProjects(): Promise<RunningProject[]> {
  const account = await authorizedRecord();
  const workspaces = await menuBarWorkspaces();
  const terminals = host ? await request<TerminalSession[]>({ t: "list" }) : [];
  const marks = await readAgentMarks(agentMarksFile());
  const results: RunningProject[] = [];
  // Sequential reads bound disk work, even with many linked projects.
  for (const project of workspaces) {
    const workspace = project.id ?? project.slug;
    const prefix = `/w/${encodeURIComponent(project.slug)}`;
    const live = terminals.filter(
      (entry) => entry.workspace === workspace && !entry.exit,
    );
    const folder = await terminalFolder(workspace);
    const conversations = folder
      ? applyAgentMarks(
          await listAgentSessions(
            agentHome(),
            folder,
            keptKeys(marks),
            Infinity,
          ),
          marks,
        )
      : [];
    const items: RunningProject["items"] = live.map((entry) => {
      const conversation = conversations.find(
        (row) => row.agent === entry.kind && row.id === entry.resume,
      );
      const name =
        entry.kind === "shell"
          ? entry.shell
          : (conversation?.title ?? entry.kind);
      const status =
        entry.kind === "shell"
          ? "Running"
          : conversation?.working
            ? "Working"
            : "Open";
      return {
        label: `${name} — ${status}, PID ${entry.pid}`,
        href:
          entry.kind === "shell"
            ? `${prefix}/issues`
            : `${prefix}/agents/${encodeURIComponent(entry.id)}`,
        ...(entry.kind === "shell" ? { shellId: entry.id } : {}),
      };
    });
    for (const conversation of conversations) {
      // Include working conversations started outside the app, too.
      if (
        conversation.working &&
        !live.some(
          (entry) =>
            entry.kind === conversation.agent &&
            entry.resume === conversation.id,
        )
      ) {
        items.push({
          label: `${conversation.title} — Working (external)`,
          href: `${prefix}/issues`,
        });
      }
      for (const sub of conversation.subagents.filter(
        (entry) => entry.working,
      )) {
        items.push({
          label: `${sub.title || sub.id} — Working (sub-agent)`,
          href: `${prefix}/agents/sub/${conversation.id}/${encodeURIComponent(sub.id)}?agent=${conversation.agent}`,
        });
      }
      if (
        folder &&
        conversation.agent === "claude" &&
        conversation.background.running > 0
      ) {
        const tasks = await readBackgroundTasks(
          agentHome(),
          folder,
          conversation.id,
        );
        for (const task of tasks.filter(
          (entry) => entry.status === "running",
        )) {
          if (
            task.kind === "agent" &&
            conversation.subagents.some(
              (sub) => sub.id === task.subagentId && sub.working,
            )
          )
            continue;
          items.push({
            label: `${task.description || task.kind} — Running (${task.kind})`,
            href:
              task.kind === "agent" && task.subagentId
                ? `${prefix}/agents/sub/${conversation.id}/${encodeURIComponent(task.subagentId)}?agent=claude`
                : `${prefix}/agents/task/${conversation.id}/${encodeURIComponent(task.id)}`,
          });
        }
      }
    }
    if (items.length)
      results.push({
        name: project.name,
        workspace,
        slug: project.slug,
        items,
      });
  }
  const current = await authorizedRecord();
  if (
    current.machineId !== account.machineId ||
    current.secret !== account.secret ||
    current.apiUrl !== account.apiUrl ||
    current.userId !== account.userId
  )
    throw new Error("Your session changed.");
  return results;
}

/**
 * Which projects the running terminals belong to, one line each —
 * `fuongz/may: claude, zsh` — for the quit prompt: they may all be in
 * projects other than the one on screen. Empty when they cannot be read.
 */
async function liveTerminalsText(): Promise<string> {
  const tabs = await request<TerminalSession[]>({ t: "list" }, 2_000).catch(
    (): TerminalSession[] => [],
  );
  const byWorkspace = new Map<string, string[]>();
  for (const tab of tabs) {
    if (tab.exit) continue;
    const kinds = byWorkspace.get(tab.workspace) ?? [];
    kinds.push(tab.kind === "shell" ? tab.shell : tab.kind);
    byWorkspace.set(tab.workspace, kinds);
  }
  const lines = await Promise.all(
    [...byWorkspace].map(async ([key, kinds]) => {
      const name = await knownWorkspace(key)
        .then(({ workspace }) => workspace.name)
        .catch(() => key);
      return `${name}: ${kinds.join(", ")}`;
    }),
  );
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

/**
 * Quitting with shells still running asks first (FE-19/D8).
 *
 * NOTE: Skipped only in an unpackaged app booted by the test suite, which
 * cannot answer a native dialog, and whose quit would otherwise wait on it
 * forever.
 *
 * @returns whether to go on quitting; every terminal is killed when true.
 */
async function confirmQuit(): Promise<boolean> {
  const live = await request<number>({ t: "count" }, 2_000).catch(() => 0);
  const unattended =
    !app.isPackaged && Boolean(process.env.LANEWORK_TEST_USER_DATA);
  if (live > 0 && !unattended) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message:
        live === 1
          ? "A terminal is still running."
          : `${live} terminals are still running.`,
      detail: `${await liveTerminalsText()}Quitting Lanework stops them.`,
    });
    if (response !== 0) return false;
  }
  await request({ t: "killAll" }, 2_000).catch(() => undefined);
  return true;
}

/**
 * The live agent tab (Claude or Codex) on `conversation`, if any — so the
 * chat's composer never writes a conversation a tab is writing too (FE-62).
 *
 * NOTE: Codex refuses a second writer outright ("thread … already has an
 * active writer"), so a `codex resume` tab must count as well.
 */
export async function agentTerminalOn(
  workspace: string,
  conversation: string,
): Promise<string | null> {
  if (!host) return null;
  const tabs = await agentTerminals(workspace).catch(
    (): TerminalSession[] => [],
  );
  return (
    tabs.find(
      (entry) =>
        entry.kind !== "shell" && !entry.exit && entry.resume === conversation,
    )?.id ?? null
  );
}

/** Stop one tab from main, as the renderer's Stop does (FE-62 take-over). */
export async function killTerminal(id: string): Promise<void> {
  if (host) await request({ t: "kill", id });
}

/** Register the terminal's IPC handlers and the prompt before quitting. */
export function registerTerminal(devUrl?: string): void {
  // So Claude's limits are known before the footer first asks.
  startClaudeUsagePoll();
  // NOTE: Not `handle()`: the port goes back to THIS sender, so the handler
  // needs the event. The sender check is the same one `handle()` applies.
  ipcMain.handle(terminalChannels.connect, (event) => {
    assertTrustedSender(event, devUrl);
    const { port1, port2 } = new MessageChannelMain();
    ensureHost().postMessage({ t: "connect" }, [port1]);
    event.sender.postMessage(terminalChannels.port, null, [port2]);
    return true;
  });
  handle(
    terminalChannels.list,
    devUrl,
    async (args): Promise<TerminalSession[]> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      const workspace = key(args[0], "workspace");
      // Nothing was ever started: no reason to start a process to say so.
      if (!host) return [];
      return agentTerminals(workspace);
    },
  );
  handle(
    terminalChannels.spawn,
    devUrl,
    async (args): Promise<TerminalSession> => {
      if (args.length < 3 || args.length > 6)
        throw new Error("A workspace and a size are required");
      const workspace = key(args[0], "workspace");
      const cols = clampGeometry(args[1], 80);
      const rows = clampGeometry(args[2], 24);
      // NOTE: One of three names, checked here: what an agent tab types is
      // decided by the host from the name, never sent (FE-19/D8).
      const kind = args[3] ?? "shell";
      if (!isTerminalKind(kind)) throw new Error("Unknown kind of terminal");
      // NOTE: A resume id is one this folder's listing has, for that agent,
      // not merely one shaped right (FE-23). The host checks the shape again.
      // `null` is "none", sent only to put a card behind it.
      const resume = args[4] ?? undefined;
      if (resume !== undefined) {
        if (kind === "shell" || !isAgentSessionId(resume))
          throw new Error("Unknown conversation");
        const known = await agentSessionsOf(workspace);
        if (!known.some((entry) => entry.id === resume && entry.agent === kind))
          throw new Error("That conversation is not in this project.");
      }
      const card = args.length === 6 ? await cardFor(workspace, args[5]) : null;
      if (card && (kind === "shell" || resume !== undefined))
        throw new Error("A card starts a new agent.");
      const cwd = await terminalFolder(workspace);
      return request<TerminalSession>({
        t: "spawn",
        workspace,
        cwd,
        cols,
        rows,
        kind,
        resume,
        card,
      });
    },
  );
  // Asked from the panel's + menu, which only exists beside a running
  // terminal — so starting the host here starts nothing it did not have.
  handle(
    terminalChannels.agents,
    devUrl,
    async (args): Promise<TerminalAgent[]> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      return request<TerminalAgent[]>({ t: "agents" });
    },
  );
  // Read in MAIN, not the pty host: listing files starts no process, and the
  // rail asks for this on every project, most of which never open a terminal.
  handle(
    terminalChannels.agentSessions,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      return agentSessionsOf(key(args[0], "workspace"));
    },
  );
  handle(
    terminalChannels.agentSessionRename,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 4)
        throw new Error("A workspace, a conversation and a name are required");
      const { workspace, key: mark } = await markable(args);
      const name = cleanAgentName(args[3]);
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        // Empty is "back to the CLI's own title".
        name: name || undefined,
      }));
      return agentSessionsOf(workspace);
    },
  );
  handle(
    terminalChannels.agentSessionPin,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 4 || typeof args[3] !== "boolean")
        throw new Error("A workspace, a conversation and a pin are required");
      const { workspace, key: mark } = await markable(args);
      const pinned = args[3];
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        pinnedAt: pinned ? (current.pinnedAt ?? Date.now()) : undefined,
      }));
      return agentSessionsOf(workspace);
    },
  );
  // NOTE: Deletes the CLI's own files for good (FE-57). The id must be one
  // this project lists (`markable`), and a conversation a tab of ours is
  // running is refused: the CLI would only write it again.
  handle(
    terminalChannels.agentSessionDelete,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A workspace and a conversation are required");
      const { workspace, key: mark } = await markable(args);
      const agent = args[1] as TerminalAgent;
      const id = args[2] as string;
      const terminals = host
        ? await request<TerminalSession[]>({ t: "list", workspace })
        : [];
      if (
        terminals.some(
          (entry) => entry.resume === id && entry.kind === agent && !entry.exit,
        )
      )
        throw new Error("Stop this conversation before deleting it.");
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      await deleteAgentTranscript(agentHome(), folder, agent, id);
      await updateAgentMark(agentMarksFile(), mark, () => ({}));
      return agentSessionsOf(workspace);
    },
  );
  // NOTE: Into the CLI's own archive. `markable` first, and refused while a
  // tab of ours runs it (FE-72/D5), as Delete is. The pin goes (FE-72/D3);
  // the name stays, for the archived list and for when it comes back.
  handle(
    terminalChannels.agentSessionArchive,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A workspace and a conversation are required");
      const { workspace, key: mark } = await markable(args);
      const agent = args[1] as TerminalAgent;
      const id = args[2] as string;
      const terminals = host
        ? await request<TerminalSession[]>({ t: "list", workspace })
        : [];
      if (
        terminals.some(
          (entry) => entry.resume === id && entry.kind === agent && !entry.exit,
        )
      )
        throw new Error("Stop this conversation before archiving it.");
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      await archiveAgentTranscript(agentHome(), folder, agent, id, runCodex);
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        pinnedAt: undefined,
      }));
      return agentSessionsOf(workspace);
    },
  );
  handle(
    terminalChannels.agentArchivedSessions,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      return archivedOf(key(args[0], "workspace"));
    },
  );
  handle(
    terminalChannels.agentSessionUnarchive,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      const { workspace, folder, agent, id } = await archivedOne(args);
      await unarchiveAgentTranscript(agentHome(), folder, agent, id, runCodex);
      return archivedOf(workspace);
    },
  );
  handle(
    terminalChannels.agentArchivedDelete,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      const { workspace, folder, agent, id } = await archivedOne(args);
      await deleteArchivedTranscript(agentHome(), folder, agent, id);
      await updateAgentMark(
        agentMarksFile(),
        agentKey({ agent, id }),
        () => ({}),
      );
      return archivedOf(workspace);
    },
  );
  // NOTE: By ids alone (FE-35/D10): `subagentRequest` refuses any of another
  // shape, and the path is built from them inside the CLI's folder for this
  // workspace's own folder. A page cannot name a file to read.
  handle(
    terminalChannels.agentSubagent,
    devUrl,
    async (args): Promise<SubagentTranscript> => {
      const { workspace, ...which } = subagentRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return readSubagentTranscript(agentHome(), folder, which);
    },
  );
  // NOTE: By ids alone, as a sub-agent is (FE-42): the transcript's path is
  // built inside Claude's folder, and an output's path is the one that
  // transcript recorded, read only inside the CLI's task folder.
  handle(
    terminalChannels.agentBackgroundTasks,
    devUrl,
    async (args): Promise<BackgroundTask[]> => {
      const { workspace, conversation } = backgroundRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return readBackgroundTasksWithPids(agentHome(), folder, conversation);
    },
  );
  handle(
    terminalChannels.agentTaskOutput,
    devUrl,
    async (args): Promise<BackgroundTaskOutput> => {
      const { workspace, conversation, task } = taskOutputRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return readTaskOutput(agentHome(), folder, conversation, task);
    },
  );
  handle(
    terminalChannels.agentStopTask,
    devUrl,
    async (args): Promise<{ stopped: number }> => {
      const { workspace, conversation, task } = taskOutputRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return stopBackgroundTask(agentHome(), folder, conversation, task);
    },
  );
  // NOTE: By workspace alone (FE-68): the folders and the terminals whose
  // processes count are main's to resolve; Stop names a pid, and main checks
  // it still listens in this project before anything is signalled.
  handle(
    terminalChannels.ports,
    devUrl,
    async (args): Promise<ListeningPort[]> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      const workspace = key(args[0], "workspace");
      return listPorts(
        await projectFolders(workspace),
        await liveTerminalPids(workspace),
      );
    },
  );
  handle(
    terminalChannels.stopPort,
    devUrl,
    async (args): Promise<{ stopped: number }> => {
      if (args.length !== 3)
        throw new Error("A workspace and a pid are required");
      const workspace = key(args[0], "workspace");
      return stopPort(
        await projectFolders(workspace),
        await liveTerminalPids(workspace),
        args[1] as number,
        args[2] as string,
      );
    },
  );
  // NOTE: By workspace alone (FE-41): the goals are those of the Codex
  // conversations its own listing last answered, and the quota is the
  // account's. A page names no file and no thread.
  handle(
    terminalChannels.codexUsage,
    devUrl,
    async (args): Promise<CodexUsage> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      const workspace = key(args[0], "workspace");
      const listed =
        listedKeys.get(workspace) ??
        new Set((await agentSessionsOf(workspace)).map(agentKey));
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
  // NOTE: By ids alone, as a sub-agent is read (FE-38): `factsRequest` refuses
  // any other shape, and the path is built inside the CLI's folder for this
  // workspace's own folder. Never part of the listing: the rail would pay
  // for every row's numbers to show none of them.
  handle(
    terminalChannels.agentFacts,
    devUrl,
    async (args): Promise<AgentFacts> => {
      const { workspace, agent, id } = factsRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return readAgentFacts(agentHome(), folder, agent, id);
    },
  );
  // Asked by Settings when it shows the project, and only then (FE-38/D6):
  // it reads the end of every transcript the folder had this month.
  handle(
    terminalChannels.agentUsage,
    devUrl,
    async (args): Promise<AgentUsage | null> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      const folder = await terminalFolder(key(args[0], "workspace"));
      if (!folder) return null;
      return readAgentUsage(agentHome(), folder);
    },
  );
  // NOTE: By ids alone, as a sub-agent is (FE-39): `agentFilesRequest` refuses
  // any other shape, and every transcript's path is built inside the CLI's
  // folder for this workspace's own folder.
  handle(
    terminalChannels.agentFiles,
    devUrl,
    async (args): Promise<AgentFiles> => {
      const { workspace, ...which } = agentFilesRequest(args);
      const folder = await terminalFolder(workspace);
      if (!folder) throw new Error("This project has no folder here.");
      return readAgentFiles(agentHome(), folder, which);
    },
  );
  // Only the conversations this workspace's own listing has (FE-39/D2).
  handle(
    terminalChannels.agentFilesForWorktree,
    devUrl,
    async (args): Promise<AgentFileMarks> => {
      if (args.length !== 1) throw new Error("A workspace is required");
      const workspace = key(args[0], "workspace");
      const folder = await terminalFolder(workspace);
      if (!folder) return { files: {}, partial: false };
      return agentFileMarks(
        agentHome(),
        folder,
        await agentSessionsOf(workspace),
      );
    },
  );
  handle(terminalChannels.reorder, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A workspace and an order are required");
    const workspace = key(args[0], "workspace");
    const ids = args[1];
    if (
      !Array.isArray(ids) ||
      ids.length > TERMINAL_LIMITS.perWorkspace ||
      !ids.every((id) => typeof id === "string" && id.length <= 200)
    )
      throw new Error("A valid order is required");
    if (!host) return;
    await request({ t: "reorder", workspace, ids });
  });
  handle(terminalChannels.kill, devUrl, async (args): Promise<void> => {
    if (args.length !== 1) throw new Error("A terminal is required");
    const id = key(args[0], "terminal");
    if (!host) return;
    await request({ t: "kill", id });
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !host) return;
    event.preventDefault();
    void confirmQuit().then((go) => {
      if (!go) return;
      quitting = true;
      app.quit();
    });
  });
  app.on("will-quit", () => {
    host?.kill();
  });
  // NOTE: The dev launcher restarts the app with SIGTERM on every
  // main-process save, and WAITS for it to exit. Behind the "a terminal is
  // still running" prompt that exit never comes: the old build keeps
  // running, unseen, and a change looks like it did nothing. A signal is not
  // a person quitting, so an unpackaged run stops without asking.
  if (!app.isPackaged)
    process.once("SIGTERM", () => {
      quitting = true;
      host?.kill();
      app.exit(0);
    });
}
