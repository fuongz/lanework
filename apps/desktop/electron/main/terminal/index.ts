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
  AGENT_SESSION_LIMIT,
  type AgentFacts,
  type AgentFileMarks,
  type AgentFiles,
  type AgentPullProgress,
  type AgentPullResult,
  type AgentSession,
  type AgentUsage,
  type AgentWrite,
  type ArchivedAgentSession,
  type BackgroundTask,
  type BackgroundTaskOutput,
  type CardBrief,
  clampGeometry,
  isAgentPullList,
  isAgentSessionId,
  isAgentSessionIdOf,
  isBoardId,
  isCardBrief,
  isTerminalAgent,
  isTerminalKind,
  type ListeningPort,
  type SubagentTranscript,
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalCommand,
  type TerminalSession,
  terminalChannels,
} from "../../../shared/terminal";
import {
  openSessionStore,
  type SessionStore,
  sessionKey,
} from "../../session-store";
import { assertTrustedSender, broadcast, handle } from "../ipc";
import { appHomeDir, sessionStorePath } from "../paths";
import {
  knownProject,
  menuBarProjects,
  projectFolders,
  terminalFolder,
} from "../projects";
import {
  allCodexRollouts,
  claudeTranscriptOf,
  type IngestSource,
  pullIntoStore,
} from "../sessions";
import { agentHomeDir } from "../test-seams";
import { STALE_MS, SUBAGENT_STALE_MS } from "../transcripts/activity";
import { ingestSession, watchAgentActivity } from "./agent-activity";
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
  bindConductor,
  conductorIn,
  importLegacyMarksOnce,
  nameSession,
  pinSession,
  releaseConductor,
} from "./agent-marks";
import { notifyAgentCompleted } from "./agent-notifications";
import { agentKey } from "./agent-sessions";
import {
  backgroundRequest,
  readBackgroundTasksWithPids,
  readTaskOutput,
  stopBackgroundTask,
  taskOutputRequest,
} from "./background-tasks";
import { runOpencode } from "./opencode-cli";
import { listPorts, stopPort } from "./ports";
import { readSubagentTranscript, subagentRequest } from "./subagent-transcript";
import { codexCli, codexDirs, registerUsage } from "./usage";

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

/** A project key or session id off the wire. */
function key(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error(`A valid ${what} is required`);
  return value;
}

/**
 * The card a new agent tab is for, with the board it is on (FE-34/D3).
 *
 * NOTE: The board is the PROJECT's own id, looked up here, never one the
 * renderer names. A page can only start an agent on the board of the project
 * it is already allowed to open a terminal for.
 *
 * @throws when the card is malformed or the project has no board.
 */
async function cardFor(
  project: string,
  value: unknown,
): Promise<CardBrief & { boardId: string }> {
  if (!isCardBrief(value)) throw new Error("Unknown card");
  const { project: known } = await knownProject(project);
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

// ── Lanework's session store (FE-112) ───────────────────────────────────────

/** The file Lanework kept its names and pins in before FE-112. */
function legacyMarksFile(): string {
  return join(appHomeDir(), "agent-sessions.json");
}

let store: SessionStore | null = null;
let storeClosed = false;

/**
 * Lanework's session store, `<home>/lw.db`: opened on first use, closed when
 * the app quits.
 *
 * Its first open carries `agent-sessions.json` over, once
 * (`importLegacyMarksOnce`).
 *
 * @throws When it cannot be opened (a newer build's file), or once the app
 *   is quitting.
 */
function sessionStore(): SessionStore {
  if (store) return store;
  if (storeClosed) throw new Error("Lanework is quitting.");
  const opened = openSessionStore({ path: sessionStorePath() });
  importLegacyMarksOnce(opened, legacyMarksFile());
  store = opened;
  return opened;
}

function closeSessionStore(): void {
  storeClosed = true;
  store?.close();
  store = null;
}

/** Ask every window showing `project`'s rail to list it again. */
function touchRail(project: string): void {
  if (host) void request({ t: "touch", project }).catch(() => undefined);
}

/**
 * Read one conversation's new bytes into the store, and have the rail list
 * it again when that gave it its first title.
 *
 * @param create Read it in though the store has no row for it.
 */
async function readInto(
  project: string,
  folder: string,
  key: string,
  source: IngestSource,
  create = false,
): Promise<void> {
  const read = await ingestSession(sessionStore(), key, source, {
    project,
    folder,
    home: agentHome(),
    create,
  });
  if (read.appeared) touchRail(project);
}

/**
 * Make a conversation Lanework starts or resumes known to its session store
 * (FE-112).
 *
 * The rail then lists it without a Pull, once its first prompt is in, and
 * the transcript watcher reads its writes. A row the store already has is
 * left as it is; a stub a legacy mark made, with no project yet, is placed
 * in this one. Then its transcript is read, if there is one yet.
 *
 * NOTE: The id is main's own, the host's or the CLI's, never the page's.
 *
 * @param folder The folder it runs in; looked up when not given.
 * @param source Its transcript, when known. A Claude one's is worked out.
 * @throws When `id` is not `agent`'s, or the store cannot be opened.
 */
export async function registerAgentSession(
  project: string,
  agent: TerminalAgent,
  id: string,
  folder?: string | null,
  source?: string | null,
): Promise<void> {
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  const where =
    folder === undefined
      ? await terminalFolder(project).catch(() => null)
      : folder;
  const sessions = sessionStore();
  const key = sessionKey(agent, id);
  const file =
    source ??
    (agent === "claude" && where
      ? claudeTranscriptOf(agentHome(), where, id)
      : null);
  const row = sessions.getSession(key);
  if (!row || row.project === null)
    sessions.upsertSession({
      agent,
      id,
      project,
      folder: where,
      // Untitled until its first prompt is read: the rail shows its tab as
      // new until then.
      cliTitle: "",
      updatedAt: new Date().toISOString(),
      origin: "lanework",
      sourcePath: file,
    });
  if (!where) return;
  watchProject(project, where);
  const read = sourceOf(agent, id, file);
  if (read) await readInto(project, where, key, read);
}

/**
 * What a read of conversation `id` reads: its transcript, or for OpenCode,
 * which keeps none as a file, its id. Null without a transcript to read.
 */
function sourceOf(
  agent: TerminalAgent,
  id: string,
  file: string | null,
): IngestSource | null {
  if (agent === "opencode") return { agent: "opencode", id };
  if (!file) return null;
  return agent === "claude"
    ? { agent: "claude", file }
    : { agent: "codex", file };
}

/**
 * Make a conversation main just started a conductor's own in `project`
 * (FE-95).
 *
 * NOTE: Not through `markable`: a conversation this new has no title the
 * rail could show yet. The id is main's (`conversation.start`), never the
 * page's.
 */
export async function bindConductorConversation(
  project: string,
  agent: TerminalAgent,
  id: string,
  conductor: string,
): Promise<void> {
  await registerAgentSession(project, agent, id);
  bindConductor(sessionStore(), sessionKey(agent, id), {
    id: conductor,
    project,
  });
}

/**
 * The conductor whose own conversation `id` is in `project`, or null.
 */
export async function conductorOfConversation(
  project: string,
  agent: TerminalAgent,
  id: string,
): Promise<string | null> {
  return conductorIn(sessionStore(), sessionKey(agent, id), project);
}

/**
 * Name a conversation main just started, as the rail's Rename would.
 *
 * @throws When the name is not one line of at most `AGENT_NAME_MAX`, or the
 *   store has no such conversation (`registerAgentSession` first).
 */
export async function nameConversation(
  agent: TerminalAgent,
  id: string,
  name: string,
): Promise<void> {
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  if (!nameSession(sessionStore(), sessionKey(agent, id), name))
    throw new Error("That conversation is not one Lanework has.");
}

/**
 * One transcript watcher per project that has been listed, restarted when
 * its folder changes (FE-25/D3).
 *
 * Started by the LISTING, not by a subscribe call: the rail lists a project
 * as soon as it shows it, which is when its rows need to be able to spin.
 * Also by a conversation Lanework starts in a project (FE-112), whose row
 * only the watcher fills in. Capped at {@link WATCH_LIMIT}, the project
 * least recently listed let go first, because every project somebody has
 * looked at in this run would otherwise keep a watcher.
 */
const watching = new Map<string, { folder: string; stop: () => void }>();
const WATCH_LIMIT = 8;

function watchProject(project: string, folder: string): void {
  const current = watching.get(project);
  watching.delete(project);
  if (current?.folder === folder) {
    // Listed again: the newest in the cap's order.
    watching.set(project, current);
    return;
  }
  current?.stop();
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
        project,
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
      rebind(project);
      // Also for a view showing its numbers, which move on every write of a
      // turn, most of which change no state.
      broadcast(terminalChannels.agentWritten, {
        project,
        agent,
        id,
        at: Date.now(),
      } satisfies AgentWrite);
    },
    (agent, id) => {
      // Only a conversation Lanework holds for this project notifies, as
      // only those are on its rail (FE-112): one never pulled stays quiet.
      const row = sessionStore().getSession(sessionKey(agent, id));
      if (!row || row.project !== project || row.archivedAt !== null) return;
      void knownProject(project)
        .then(async ({ project: found }) => {
          const tabs = host
            ? await agentTerminals(project).catch((): TerminalSession[] => [])
            : [];
          const tab = tabs.find(
            (entry) =>
              entry.kind === agent && !entry.exit && entry.resume === id,
          );
          // A project removed or rebound since must not deliver a late
          // notification.
          if (watching.get(project)?.folder === folder)
            notifyAgentCompleted(agent, found, id, tab?.id ?? null);
        })
        .catch(() => {});
    },
    // FE-112: a settled write of a conversation the store has is read into
    // it. One that only now has a title is new to the rail: a tab's first
    // prompt, say, which the activity watcher may not count as news.
    {
      store: sessionStore,
      project,
      onIngested: (_key, appeared) => {
        if (appeared) touchRail(project);
      },
    },
  );
  watching.set(project, { folder, stop });
}

/**
 * `project`'s rail as Lanework's session store lists it, ready to show.
 *
 * - A conversation nothing was typed in yet, registered when Lanework
 *   started it, is left out: the rail shows its tab as new until then.
 * - The newest {@link AGENT_SESSION_LIMIT} of the rest, every pinned and
 *   conductor's one besides.
 * - `working` is what the last read found, and nothing ages it: one not
 *   written for `STALE_MS` is not working, whatever that read said, so a row
 *   never spins for good. Its card goes with it; a sub-agent's the same, past
 *   `SUBAGENT_STALE_MS`.
 *
 * @param listed `listRail`'s rows, newest first.
 */
function railOf(listed: AgentSession[], now = Date.now()): AgentSession[] {
  const out: AgentSession[] = [];
  let rest = 0;
  for (const session of listed) {
    if (!session.cliTitle) continue;
    const kept = session.pinnedAt !== null || session.conductor !== null;
    if (!kept && rest >= AGENT_SESSION_LIMIT) continue;
    if (!kept) rest += 1;
    const working =
      session.working && now - Date.parse(session.updatedAt) <= STALE_MS;
    out.push({
      ...session,
      working,
      card: working ? session.card : null,
      subagents: session.subagents.map((sub) =>
        sub.working && now - Date.parse(sub.updatedAt) > SUBAGENT_STALE_MS
          ? { ...sub, working: false }
          : sub,
      ),
    });
  }
  return out;
}

/** `project`'s rows as the store has them, before {@link railOf}. */
function storedRail(project: string): AgentSession[] {
  // Twice the limit: rows nothing was typed in yet take no place on it.
  return sessionStore().listRail(project, AGENT_SESSION_LIMIT * 2);
}

/**
 * The conversations Lanework lists for `project` (FE-112), with its names
 * and pins; none without a folder here, where nothing could resume them.
 *
 * NOTE: A SELECT, no CLI file read: a conversation started outside Lanework
 * joins through a Pull. Listing starts the project's watcher, which keeps
 * the rows it has up to date.
 */
async function agentSessionsOf(project: string): Promise<AgentSession[]> {
  const folder = await terminalFolder(project);
  if (!folder) return [];
  watchProject(project, folder);
  return railOf(storedRail(project));
}

/** `project`'s listed conversations as `agent:id`; none when unreadable. */
function railKeys(project: string): Set<string> {
  try {
    return new Set(railOf(storedRail(project)).map(agentKey));
  } catch {
    return new Set();
  }
}

/** Projects with a re-check in flight: true when another was asked for. */
const rebinding = new Map<string, boolean>();
/**
 * Re-check which conversation `project`'s agent tabs are on (FE-31/D5).
 *
 * The host tells every window if one moved. One run at a time per
 * project, and at most one more queued behind it: a turn writes its
 * transcript many times a second.
 */
function rebind(project: string): void {
  if (!host) return;
  if (rebinding.has(project)) {
    rebinding.set(project, true);
    return;
  }
  rebinding.set(project, false);
  void agentTerminals(project)
    .catch(() => undefined)
    .finally(() => {
      const again = rebinding.get(project);
      rebinding.delete(project);
      // One run for all that queued: the first starts it, the rest join.
      if (again) rebind(project);
    });
}

let movesWatch: FSWatcher | null = null;
let movesTimer: NodeJS.Timeout | null = null;
/**
 * Watch Claude's own record of which conversation each of its processes is
 * on, and re-check every listed project when it changes.
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
        for (const project of watching.keys()) rebind(project);
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

/** The pty pids of `project`'s open terminals; none before any started. */
async function liveTerminalPids(project: string): Promise<number[]> {
  if (!host) return [];
  const listed = await request<TerminalSession[]>({ t: "list", project });
  return listed.filter((entry) => !entry.exit).map((entry) => entry.pid);
}

/**
 * `project`'s tabs, each agent tab on the conversation it is on NOW.
 *
 * A tab that moved is moved in the host too, which tells every window, so
 * the rail regroups without polling (FE-31/D5). The conversation it moved to
 * is one Lanework runs, so the store gets its row (FE-112): a new Codex
 * tab's, or the one a Claude `/clear` started. Best effort: a folder that
 * cannot be read keeps what the host had.
 */
async function agentTerminals(project: string): Promise<TerminalSession[]> {
  const listed = await request<TerminalSession[]>({ t: "list", project });
  if (!listed.some((entry) => entry.kind !== "shell" && !entry.exit))
    return listed;
  const folder = await terminalFolder(project);
  if (!folder) return listed;
  const rollouts = new Map<string, string>();
  const bindings = await agentBindings(
    agentHome(),
    folder,
    listed,
    rollouts,
  ).catch(() => []);
  if (bindings.length === 0) return listed;
  await request({ t: "bind", project, bindings });
  const moved = new Map(bindings.map((entry) => [entry.id, entry.resume]));
  for (const entry of listed) {
    const to = moved.get(entry.id);
    if (to && entry.kind !== "shell")
      void registerAgentSession(
        project,
        entry.kind,
        to,
        folder,
        rollouts.get(to),
      ).catch(() => undefined);
  }
  return listed.map((entry) => ({
    ...entry,
    resume: moved.get(entry.id) ?? entry.resume,
  }));
}

/** Whether a live tab of `project` is running conversation `id`. */
async function runningInTab(
  project: string,
  agent: TerminalAgent,
  id: string,
): Promise<boolean> {
  if (!host) return false;
  const terminals = await request<TerminalSession[]>({ t: "list", project });
  return terminals.some(
    (entry) => entry.resume === id && entry.kind === agent && !entry.exit,
  );
}

/**
 * The conversation a rename, pin, archive, delete or forget names, checked
 * against Lanework's session store (FE-112).
 *
 * NOTE: The same rule a resume follows: an id the store does not list for
 * this project (none, another project's, or archived) is refused, so nothing
 * can be done to a conversation the rail was never shown.
 *
 * @throws when the arguments are malformed or the id is not listed here.
 */
function markable(args: unknown[]): {
  project: string;
  agent: TerminalAgent;
  id: string;
  key: string;
} {
  const project = key(args[0], "project");
  const agent = args[1];
  const id = args[2];
  if (!isTerminalAgent(agent)) throw new Error("A valid agent is required");
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  const mark = sessionKey(agent, id);
  const row = sessionStore().getSession(mark);
  if (!row || row.project !== project || row.archivedAt !== null)
    throw new Error("That conversation is not one of this project's");
  return { project, agent, id, key: mark };
}

/** The project's archived conversations, with Lanework's names. */
async function archivedOf(project: string): Promise<ArchivedAgentSession[]> {
  const folder = await terminalFolder(project);
  if (!folder) return [];
  const archived = await listArchivedAgentSessions(agentHome(), folder);
  const sessions = sessionStore();
  return archived.map((entry) => ({
    ...entry,
    title: sessions.getSession(agentKey(entry))?.name ?? entry.title,
  }));
}

/**
 * The archived conversation an unarchive or a delete names.
 *
 * Checked against Lanework's session store (FE-112): one it archived for
 * this project. One archived some other way (before the store, or by the
 * CLI itself) is checked against the project's archived list instead,
 * {@link markable}'s rule for the archive; another project's never.
 *
 * @throws when the arguments are malformed or the id is not archived here.
 */
async function archivedOne(args: unknown[]): Promise<{
  project: string;
  folder: string;
  agent: TerminalAgent;
  id: string;
}> {
  if (args.length !== 3)
    throw new Error("A project and a conversation are required");
  const project = key(args[0], "project");
  const agent = args[1];
  const id = args[2];
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  const folder = await terminalFolder(project);
  if (!folder) throw new Error("This project has no folder here.");
  const row = sessionStore().getSession(sessionKey(agent, id));
  const known =
    row?.project === project && row.archivedAt !== null
      ? true
      : row?.project && row.project !== project
        ? false
        : (await listArchivedAgentSessions(agentHome(), folder)).some(
            (entry) => entry.agent === agent && entry.id === id,
          );
  if (!known)
    throw new Error("That conversation is not in this project's archive");
  return { project, folder, agent, id };
}

/** Where Codex keeps conversation `id`'s rollout, if it has it at all. */
async function codexRolloutOfId(id: string): Promise<string | null> {
  const all = await allCodexRollouts(join(agentHome(), ".codex", "sessions"));
  return all.find((file) => file.endsWith(`-${id}.jsonl`)) ?? null;
}

// ── Pull (FE-112) ───────────────────────────────────────────────────────────

/** The Pull running now: one at a time. */
let pullRun: AbortController | null = null;

/** The CLIs a Pull reads, off the wire. */
function pullAgents(value: unknown): TerminalAgent[] {
  if (!isAgentPullList(value))
    throw new Error("Pick at least one agent to pull from.");
  return [...value];
}

/** What a failure says, for a person to read. */
function said(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "It stopped for no reason it gave.";
}

/**
 * Pull the conversations of each `{project, folder}` into the store, one
 * project at a time.
 *
 * Every agent of every project ends on `done`, `failed` or `cancelled`, told
 * to every window on `agentPullProgress`; one cancelled before its turn
 * came ends `cancelled` at nought. One project failing does not stop the
 * next.
 *
 * @param targets Resolved once this Pull holds the lock.
 * @param alone One project's Pull: its failure is the Pull's.
 * @throws Readably, when another Pull runs, the projects or the store
 *   cannot be read, or nothing could be pulled.
 */
async function pullInto(
  targets: () => Promise<{ project: string; folder: string }[]>,
  agents: TerminalAgent[],
  alone: boolean,
): Promise<AgentPullResult> {
  if (pullRun)
    throw new Error(
      "A Pull is already running. Wait for it to finish, or cancel it.",
    );
  const run = new AbortController();
  pullRun = run;
  const progress = (step: AgentPullProgress) =>
    broadcast(terminalChannels.agentPullProgress, step);
  try {
    const sessions = sessionStore();
    const list = await targets();
    let pulled = 0;
    let failure: unknown = null;
    for (const [at, target] of list.entries()) {
      if (run.signal.aborted) {
        for (const { project } of list.slice(at))
          for (const agent of agents)
            progress({ project, agent, done: 0, total: 0, phase: "cancelled" });
        break;
      }
      try {
        const outcome = await pullIntoStore(sessions, {
          project: target.project,
          folder: target.folder,
          agents,
          home: agentHome(),
          signal: run.signal,
          onProgress: progress,
        });
        pulled += outcome.pulled;
        // Another window showing it lists it again too.
        if (outcome.pulled > 0) touchRail(target.project);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null && (alone || pulled === 0))
      throw new Error(`Couldn't pull the sessions: ${said(failure)}`);
    return { pulled };
  } finally {
    if (pullRun === run) pullRun = null;
  }
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

/**
 * Which projects the running terminals belong to, one line each —
 * `fuongz/may: claude, zsh` — for the quit prompt: they may all be in
 * projects other than the one on screen. Empty when they cannot be read.
 */
async function liveTerminalsText(): Promise<string> {
  const tabs = await request<TerminalSession[]>({ t: "list" }, 2_000).catch(
    (): TerminalSession[] => [],
  );
  const byProject = new Map<string, string[]>();
  for (const tab of tabs) {
    if (tab.exit) continue;
    const kinds = byProject.get(tab.project) ?? [];
    kinds.push(tab.kind === "shell" ? tab.shell : tab.kind);
    byProject.set(tab.project, kinds);
  }
  const lines = await Promise.all(
    [...byProject].map(async ([key, kinds]) => {
      const name = await knownProject(key)
        .then(({ project }) => project.name)
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
  project: string,
  conversation: string,
): Promise<string | null> {
  if (!host) return null;
  const tabs = await agentTerminals(project).catch((): TerminalSession[] => []);
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
  // Claude's and Codex's limits: their IPC, and the poll that starts now so
  // Claude's are known before the footer first asks.
  registerUsage(devUrl, {
    projects: () => watching.keys(),
    keysOf: railKeys,
  });
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
      if (args.length !== 1) throw new Error("A project is required");
      const project = key(args[0], "project");
      // Nothing was ever started: no reason to start a process to say so.
      if (!host) return [];
      return agentTerminals(project);
    },
  );
  handle(
    terminalChannels.spawn,
    devUrl,
    async (args): Promise<TerminalSession> => {
      if (args.length < 3 || args.length > 6)
        throw new Error("A project and a size are required");
      const project = key(args[0], "project");
      const cols = clampGeometry(args[1], 80);
      const rows = clampGeometry(args[2], 24);
      // NOTE: One of three names, checked here: what an agent tab types is
      // decided by the host from the name, never sent (FE-19/D8).
      const kind = args[3] ?? "shell";
      if (!isTerminalKind(kind)) throw new Error("Unknown kind of terminal");
      // NOTE: A resume id is one Lanework's session store lists for this
      // project, for that agent, not merely one shaped right (FE-23,
      // FE-112). The host checks the shape again. `null` is "none", sent
      // only to put a card behind it.
      const resume = args[4] ?? undefined;
      if (resume !== undefined) {
        if (kind === "shell" || !isAgentSessionIdOf(kind, resume))
          throw new Error("Unknown conversation");
        const row = sessionStore().getSession(sessionKey(kind, resume));
        if (!row || row.project !== project || row.archivedAt !== null)
          throw new Error("That conversation is not in this project.");
      }
      const card = args.length === 6 ? await cardFor(project, args[5]) : null;
      if (card && (kind === "shell" || resume !== undefined))
        throw new Error("A card starts a new agent.");
      const cwd = await terminalFolder(project);
      const session = await request<TerminalSession>({
        t: "spawn",
        project,
        cwd,
        cols,
        rows,
        kind,
        resume,
        card,
      });
      // FE-112: a conversation Lanework starts is listed without a Pull.
      // Claude's and OpenCode's are named at spawn; a new Codex's once a
      // write binds its tab (`agentTerminals`).
      const agent = session.kind;
      if (agent !== "shell" && session.resume && cwd)
        void registerAgentSession(project, agent, session.resume, cwd).catch(
          () => undefined,
        );
      return session;
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
  // Read in MAIN, not the pty host: a query of Lanework's session store
  // (FE-112), and the rail asks for this on every project, most of which
  // never open a terminal.
  handle(
    terminalChannels.agentSessions,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 1) throw new Error("A project is required");
      return agentSessionsOf(key(args[0], "project"));
    },
  );
  handle(
    terminalChannels.agentSessionRename,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 4)
        throw new Error("A project, a conversation and a name are required");
      const { project, key: mark } = markable(args);
      // Empty is "back to the CLI's own title".
      nameSession(sessionStore(), mark, args[3]);
      return agentSessionsOf(project);
    },
  );
  handle(
    terminalChannels.agentSessionPin,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 4 || typeof args[3] !== "boolean")
        throw new Error("A project, a conversation and a pin are required");
      const { project, key: mark } = markable(args);
      pinSession(sessionStore(), mark, args[3]);
      return agentSessionsOf(project);
    },
  );
  handle(
    terminalChannels.agentSessionConductor,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, key: mark } = markable(args);
      releaseConductor(sessionStore(), mark);
      return agentSessionsOf(project);
    },
  );
  // NOTE: Deletes the CLI's own files for good (FE-57), and the store's row
  // with them. The id must be one this project lists (`markable`), and a
  // conversation a tab of ours is running is refused: the CLI would only
  // write it again.
  handle(
    terminalChannels.agentSessionDelete,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, agent, id } = markable(args);
      if (await runningInTab(project, agent, id))
        throw new Error("Stop this conversation before deleting it.");
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      await deleteAgentTranscript(
        agentHome(),
        folder,
        agent,
        id,
        runOpencode,
        sessionStore(),
      );
      return agentSessionsOf(project);
    },
  );
  // NOTE: Takes a conversation off Lanework only (FE-112): its row, name and
  // pin go, and the CLI's files are not touched, so a later Pull finds it
  // again. `markable` first, and refused while a tab of ours runs it, as
  // Delete is: its writes would be read into nothing.
  handle(
    terminalChannels.agentSessionForget,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, agent, id, key: mark } = markable(args);
      if (await runningInTab(project, agent, id))
        throw new Error("Stop this conversation before removing it.");
      sessionStore().removeSession(mark);
      return agentSessionsOf(project);
    },
  );
  // NOTE: Reads the CLIs' own files into Lanework's session store (FE-112),
  // in a worker thread, one Pull at a time. Only agents by name and a
  // project come off the wire: the folder is the one main wrote down for it,
  // so a page names no file to read.
  handle(
    terminalChannels.agentSessionsPull,
    devUrl,
    async (args): Promise<AgentPullResult> => {
      if (args.length !== 2)
        throw new Error("A project and the agents to pull from are required");
      const project = key(args[0], "project");
      const agents = pullAgents(args[1]);
      return pullInto(
        async () => {
          const folder = await terminalFolder(project);
          if (!folder)
            throw new Error("This project has no folder here to pull from.");
          return [{ project, folder }];
        },
        agents,
        true,
      );
    },
  );
  // Every project with a folder here, one after the other.
  handle(
    terminalChannels.agentSessionsPullAll,
    devUrl,
    async (args): Promise<AgentPullResult> => {
      if (args.length !== 1)
        throw new Error("The agents to pull from are required");
      const agents = pullAgents(args[0]);
      return pullInto(
        async () => {
          const targets: { project: string; folder: string }[] = [];
          for (const entry of await menuBarProjects()) {
            // The key the rail lists it by (`useProjectKey`).
            const project = entry.id ?? entry.slug;
            const folder = await terminalFolder(project).catch(() => null);
            if (folder) targets.push({ project, folder });
          }
          if (targets.length === 0)
            throw new Error("No project has a folder here to pull from.");
          return targets;
        },
        agents,
        false,
      );
    },
  );
  // What it read so far stays; the Pull's own answer says it was cancelled.
  handle(
    terminalChannels.agentSessionsPullCancel,
    devUrl,
    async (args): Promise<void> => {
      if (args.length !== 0) throw new Error("No arguments are taken");
      pullRun?.abort();
    },
  );
  // NOTE: Into the CLI's own archive. `markable` first, and refused while a
  // tab of ours runs it (FE-72/D5), as Delete is. The store marks it
  // archived, which drops the pin (FE-72/D3); the name stays, for the
  // archived list and for when it comes back.
  handle(
    terminalChannels.agentSessionArchive,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, agent, id } = markable(args);
      if (await runningInTab(project, agent, id))
        throw new Error("Stop this conversation before archiving it.");
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      await archiveAgentTranscript(
        agentHome(),
        folder,
        agent,
        id,
        runCodex,
        sessionStore(),
      );
      return agentSessionsOf(project);
    },
  );
  handle(
    terminalChannels.agentArchivedSessions,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      if (args.length !== 1) throw new Error("A project is required");
      return archivedOf(key(args[0], "project"));
    },
  );
  handle(
    terminalChannels.agentSessionUnarchive,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      const { project, folder, agent, id } = await archivedOne(args);
      const had = await unarchiveAgentTranscript(
        agentHome(),
        folder,
        agent,
        id,
        runCodex,
        sessionStore(),
      );
      // Archived before the store kept it (FE-112): read in now, so the rail
      // lists it again without a Pull.
      if (!had) {
        const file =
          agent === "claude"
            ? claudeTranscriptOf(agentHome(), folder, id)
            : await codexRolloutOfId(id);
        const read = sourceOf(agent, id, file);
        if (read)
          await readInto(
            project,
            folder,
            sessionKey(agent, id),
            read,
            true,
          ).catch(() => undefined);
      }
      return archivedOf(project);
    },
  );
  handle(
    terminalChannels.agentArchivedDelete,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      const { project, folder, agent, id } = await archivedOne(args);
      await deleteArchivedTranscript(
        agentHome(),
        folder,
        agent,
        id,
        sessionStore(),
      );
      return archivedOf(project);
    },
  );
  // NOTE: By ids alone (FE-35/D10): `subagentRequest` refuses any of another
  // shape, and the path is built from them inside the CLI's folder for this
  // project's own folder. A page cannot name a file to read.
  handle(
    terminalChannels.agentSubagent,
    devUrl,
    async (args): Promise<SubagentTranscript> => {
      const { project, ...which } = subagentRequest(args);
      const folder = await terminalFolder(project);
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
      const { project, conversation } = backgroundRequest(args);
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      return readBackgroundTasksWithPids(agentHome(), folder, conversation);
    },
  );
  handle(
    terminalChannels.agentTaskOutput,
    devUrl,
    async (args): Promise<BackgroundTaskOutput> => {
      const { project, conversation, task } = taskOutputRequest(args);
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      return readTaskOutput(agentHome(), folder, conversation, task);
    },
  );
  handle(
    terminalChannels.agentStopTask,
    devUrl,
    async (args): Promise<{ stopped: number }> => {
      const { project, conversation, task } = taskOutputRequest(args);
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      return stopBackgroundTask(agentHome(), folder, conversation, task);
    },
  );
  // NOTE: By project alone (FE-68): the folders and the terminals whose
  // processes count are main's to resolve; Stop names a pid, and main checks
  // it still listens in this project before anything is signalled.
  handle(
    terminalChannels.ports,
    devUrl,
    async (args): Promise<ListeningPort[]> => {
      if (args.length !== 1) throw new Error("A project is required");
      const project = key(args[0], "project");
      return listPorts(
        await projectFolders(project),
        await liveTerminalPids(project),
      );
    },
  );
  handle(
    terminalChannels.stopPort,
    devUrl,
    async (args): Promise<{ stopped: number }> => {
      if (args.length !== 3)
        throw new Error("A project and a pid are required");
      const project = key(args[0], "project");
      return stopPort(
        await projectFolders(project),
        await liveTerminalPids(project),
        args[1] as number,
        args[2] as string,
      );
    },
  );
  // NOTE: By ids alone, as a sub-agent is read (FE-38): `factsRequest` refuses
  // any other shape, and the path is built inside the CLI's folder for this
  // project's own folder. Never part of the listing: the rail would pay
  // for every row's numbers to show none of them.
  handle(
    terminalChannels.agentFacts,
    devUrl,
    async (args): Promise<AgentFacts> => {
      const { project, agent, id } = factsRequest(args);
      const folder = await terminalFolder(project);
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
      if (args.length !== 1) throw new Error("A project is required");
      const folder = await terminalFolder(key(args[0], "project"));
      if (!folder) return null;
      return readAgentUsage(agentHome(), folder);
    },
  );
  // NOTE: By ids alone, as a sub-agent is (FE-39): `agentFilesRequest` refuses
  // any other shape, and every transcript's path is built inside the CLI's
  // folder for this project's own folder.
  handle(
    terminalChannels.agentFiles,
    devUrl,
    async (args): Promise<AgentFiles> => {
      const { project, ...which } = agentFilesRequest(args);
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      return readAgentFiles(agentHome(), folder, which);
    },
  );
  // Only the conversations Lanework lists for this project (FE-39/D2,
  // FE-112).
  handle(
    terminalChannels.agentFilesForWorktree,
    devUrl,
    async (args): Promise<AgentFileMarks> => {
      if (args.length !== 1) throw new Error("A project is required");
      const project = key(args[0], "project");
      const folder = await terminalFolder(project);
      if (!folder) return { files: {}, partial: false };
      return agentFileMarks(
        agentHome(),
        folder,
        await agentSessionsOf(project),
      );
    },
  );
  handle(terminalChannels.reorder, devUrl, async (args): Promise<void> => {
    if (args.length !== 2)
      throw new Error("A project and an order are required");
    const project = key(args[0], "project");
    const ids = args[1];
    if (
      !Array.isArray(ids) ||
      ids.length > TERMINAL_LIMITS.perProject ||
      !ids.every((id) => typeof id === "string" && id.length <= 200)
    )
      throw new Error("A valid order is required");
    if (!host) return;
    await request({ t: "reorder", project, ids });
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
    pullRun?.abort();
    for (const entry of watching.values()) entry.stop();
    watching.clear();
    closeSessionStore();
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
