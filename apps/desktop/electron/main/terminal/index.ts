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
  clampGeometry,
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
import { assertTrustedSender, broadcast, handle } from "../ipc";
import { appHomeDir } from "../paths";
import {
  authorizedRecord,
  knownProject,
  menuBarProjects,
  projectFolders,
  terminalFolder,
} from "../projects";
import { agentHomeDir } from "../test-seams";
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
  bindConductor,
  cleanAgentName,
  keptKeys,
  readAgentMarks,
  updateAgentMark,
} from "./agent-marks";
import { notifyAgentCompleted } from "./agent-notifications";
import { agentKey, listAgentSessions } from "./agent-sessions";
import {
  backgroundRequest,
  readBackgroundTasks,
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

/** The file of Lanework's names and pins for agent conversations. */
function agentMarksFile(): string {
  return join(appHomeDir(), "agent-sessions.json");
}

/**
 * Make a conversation main just started a conductor's own in `project`
 * (FE-95).
 *
 * NOTE: Not through `markable`: a conversation this new has no transcript
 * the listing could show yet. The id is main's (`conversation.start`), never
 * the page's.
 */
export async function bindConductorConversation(
  project: string,
  agent: TerminalAgent,
  id: string,
  conductor: string,
): Promise<void> {
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  await bindConductor(agentMarksFile(), agentKey({ agent, id }), {
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
  const mark = (await readAgentMarks(agentMarksFile()))[
    agentKey({ agent, id })
  ];
  return mark?.conductor?.project === project ? mark.conductor.id : null;
}

/**
 * Name a conversation main just started, as the rail's Rename would.
 *
 * @throws When the name is not one line of at most `AGENT_NAME_MAX`.
 */
export async function nameConversation(
  agent: TerminalAgent,
  id: string,
  name: string,
): Promise<void> {
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  const clean = cleanAgentName(name);
  await updateAgentMark(
    agentMarksFile(),
    agentKey({ agent, id }),
    (current) => ({
      ...current,
      name: clean || undefined,
    }),
  );
}

/**
 * One transcript watcher per project that has been listed, restarted when
 * its folder changes (FE-25/D3).
 *
 * Started by the LISTING, not by a subscribe call: the rail lists a project
 * as soon as it shows it, which is when its rows need to be able to spin.
 * Capped at {@link WATCH_LIMIT}, because every project somebody has looked
 * at in this run would otherwise keep a watcher.
 */
const watching = new Map<string, { folder: string; stop: () => void }>();
const WATCH_LIMIT = 8;

function watchProject(project: string, folder: string): void {
  const current = watching.get(project);
  if (current?.folder === folder) return;
  current?.stop();
  watching.delete(project);
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
      rebind(project, agentKey({ agent, id }));
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
  );
  watching.set(project, { folder, stop });
}

/**
 * The conversations `project`'s folder has, with Lanework's names and pins
 * laid over them; none without a folder here.
 */
async function agentSessionsOf(project: string): Promise<AgentSession[]> {
  const folder = await terminalFolder(project);
  if (!folder) return [];
  watchProject(project, folder);
  const marks = await readAgentMarks(agentMarksFile());
  const listed = await listAgentSessions(agentHome(), folder, keptKeys(marks));
  listedKeys.set(project, new Set(listed.map(agentKey)));
  return applyAgentMarks(listed, marks);
}

/** Per project with a re-check in flight: the keys written meanwhile. */
const rebinding = new Map<string, Set<string>>();
/**
 * Re-check which conversation `project`'s agent tabs are on (FE-31/D5).
 *
 * The host tells every window if one moved. One run at a time per
 * project, and at most one more queued behind it: a turn writes its
 * transcript many times a second.
 *
 * @param written the agent key of the transcript just written, if any.
 */
function rebind(project: string, written?: string): void {
  if (!host) return;
  const queued = rebinding.get(project);
  if (queued) {
    // "" is a run asked for with no write behind it (a Claude move).
    queued.add(written ?? "");
    return;
  }
  const writes = new Set(written ? [written] : []);
  // The next run's writes collect here while this one is in flight.
  rebinding.set(project, new Set());
  void agentTerminals(project)
    .then((terminals) => {
      // NOTE: A tab on a conversation the rail has not been shown, whose
      // transcript was just written: list again. A new Codex's first write
      // is its `session_meta`, before the prompt that titles it, and the
      // rest of that turn is no news to the activity watcher. Without this
      // its row stays "New Codex session" until something else moves.
      const shown = listedKeys.get(project);
      const untitled = terminals.some((entry) => {
        if (entry.kind === "shell" || entry.exit || entry.resume === null)
          return false;
        const key = agentKey({ agent: entry.kind, id: entry.resume });
        return writes.has(key) && !shown?.has(key);
      });
      if (untitled) return request({ t: "touch", project });
    })
    .catch(() => undefined)
    .finally(() => {
      const next = rebinding.get(project);
      rebinding.delete(project);
      // One run for all that queued: the first starts it, the rest join.
      for (const key of next ?? []) rebind(project, key || undefined);
    });
}

/** The conversations each project's listing last answered, as keys. */
const listedKeys = new Map<string, Set<string>>();

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
 * the rail regroups without polling (FE-31/D5). Best effort: a folder that
 * cannot be read keeps what the host had.
 */
async function agentTerminals(project: string): Promise<TerminalSession[]> {
  const listed = await request<TerminalSession[]>({ t: "list", project });
  if (!listed.some((entry) => entry.kind !== "shell" && !entry.exit))
    return listed;
  const folder = await terminalFolder(project);
  if (!folder) return listed;
  const bindings = await agentBindings(agentHome(), folder, listed).catch(
    () => [],
  );
  if (bindings.length === 0) return listed;
  await request({ t: "bind", project, bindings });
  const moved = new Map(bindings.map((entry) => [entry.id, entry.resume]));
  return listed.map((entry) => ({
    ...entry,
    resume: moved.get(entry.id) ?? entry.resume,
  }));
}

/**
 * The conversation a rename or pin names, checked against the listing.
 *
 * NOTE: The same rule a resume follows: an id this project's own listing
 * does not have is refused, so nothing can be written about a conversation
 * the rail was never shown.
 *
 * @throws when the arguments are malformed or the id is not listed here.
 */
async function markable(args: unknown[]): Promise<{
  project: string;
  key: string;
}> {
  const project = key(args[0], "project");
  const agent = args[1];
  const id = args[2];
  if (!isTerminalAgent(agent)) throw new Error("A valid agent is required");
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  const known = await agentSessionsOf(project);
  if (!known.some((entry) => entry.agent === agent && entry.id === id))
    throw new Error("That conversation is not one of this project's");
  return { project, key: agentKey({ agent, id }) };
}

/** The project's archived conversations, with Lanework's names. */
async function archivedOf(project: string): Promise<ArchivedAgentSession[]> {
  const folder = await terminalFolder(project);
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
 * Checked against the project's archived list: {@link markable}'s rule, for
 * the archive.
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
  const archived = await listArchivedAgentSessions(agentHome(), folder);
  if (!archived.some((entry) => entry.agent === agent && entry.id === id))
    throw new Error("That conversation is not in this project's archive");
  return { project, folder, agent, id };
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
  project: string;
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
  const projects = await menuBarProjects();
  const terminals = host ? await request<TerminalSession[]>({ t: "list" }) : [];
  const marks = await readAgentMarks(agentMarksFile());
  const results: RunningProject[] = [];
  // Sequential reads bound disk work, even with many linked projects.
  for (const listed of projects) {
    const project = listed.id ?? listed.slug;
    const prefix = `/w/${encodeURIComponent(listed.slug)}`;
    const live = terminals.filter(
      (entry) => entry.project === project && !entry.exit,
    );
    const folder = await terminalFolder(project);
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
        name: listed.name,
        project,
        slug: listed.slug,
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
    listed: () => listedKeys,
    keysOf: async (project) =>
      listedKeys.get(project) ??
      new Set((await agentSessionsOf(project)).map(agentKey)),
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
      // NOTE: A resume id is one this folder's listing has, for that agent,
      // not merely one shaped right (FE-23). The host checks the shape again.
      // `null` is "none", sent only to put a card behind it.
      const resume = args[4] ?? undefined;
      if (resume !== undefined) {
        if (kind === "shell" || !isAgentSessionIdOf(kind, resume))
          throw new Error("Unknown conversation");
        const known = await agentSessionsOf(project);
        if (!known.some((entry) => entry.id === resume && entry.agent === kind))
          throw new Error("That conversation is not in this project.");
      }
      const card = args.length === 6 ? await cardFor(project, args[5]) : null;
      if (card && (kind === "shell" || resume !== undefined))
        throw new Error("A card starts a new agent.");
      const cwd = await terminalFolder(project);
      return request<TerminalSession>({
        t: "spawn",
        project,
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
      const { project, key: mark } = await markable(args);
      const name = cleanAgentName(args[3]);
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        // Empty is "back to the CLI's own title".
        name: name || undefined,
      }));
      return agentSessionsOf(project);
    },
  );
  handle(
    terminalChannels.agentSessionPin,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 4 || typeof args[3] !== "boolean")
        throw new Error("A project, a conversation and a pin are required");
      const { project, key: mark } = await markable(args);
      const pinned = args[3];
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        pinnedAt: pinned ? (current.pinnedAt ?? Date.now()) : undefined,
      }));
      return agentSessionsOf(project);
    },
  );
  handle(
    terminalChannels.agentSessionConductor,
    devUrl,
    async (args): Promise<AgentSession[]> => {
      if (args.length !== 3)
        throw new Error("A project and a conversation are required");
      const { project, key: mark } = await markable(args);
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        conductor: undefined,
      }));
      return agentSessionsOf(project);
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
        throw new Error("A project and a conversation are required");
      const { project, key: mark } = await markable(args);
      const agent = args[1] as TerminalAgent;
      const id = args[2] as string;
      const terminals = host
        ? await request<TerminalSession[]>({ t: "list", project })
        : [];
      if (
        terminals.some(
          (entry) => entry.resume === id && entry.kind === agent && !entry.exit,
        )
      )
        throw new Error("Stop this conversation before deleting it.");
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      await deleteAgentTranscript(agentHome(), folder, agent, id, runOpencode);
      await updateAgentMark(agentMarksFile(), mark, () => ({}));
      return agentSessionsOf(project);
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
        throw new Error("A project and a conversation are required");
      const { project, key: mark } = await markable(args);
      const agent = args[1] as TerminalAgent;
      const id = args[2] as string;
      const terminals = host
        ? await request<TerminalSession[]>({ t: "list", project })
        : [];
      if (
        terminals.some(
          (entry) => entry.resume === id && entry.kind === agent && !entry.exit,
        )
      )
        throw new Error("Stop this conversation before archiving it.");
      const folder = await terminalFolder(project);
      if (!folder) throw new Error("This project has no folder here.");
      await archiveAgentTranscript(agentHome(), folder, agent, id, runCodex);
      await updateAgentMark(agentMarksFile(), mark, (current) => ({
        ...current,
        pinnedAt: undefined,
      }));
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
      await unarchiveAgentTranscript(agentHome(), folder, agent, id, runCodex);
      return archivedOf(project);
    },
  );
  handle(
    terminalChannels.agentArchivedDelete,
    devUrl,
    async (args): Promise<ArchivedAgentSession[]> => {
      const { project, folder, agent, id } = await archivedOne(args);
      await deleteArchivedTranscript(agentHome(), folder, agent, id);
      await updateAgentMark(
        agentMarksFile(),
        agentKey({ agent, id }),
        () => ({}),
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
  // Only the conversations this project's own listing has (FE-39/D2).
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
