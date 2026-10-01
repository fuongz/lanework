// The main process's side of the terminal (FE-19): starting the pty host,
// answering the panel's requests, and handing windows a port to it.
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
  type AgentSession,
  clampGeometry,
  isAgentSessionId,
  isTerminalKind,
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalCommand,
  type TerminalSession,
  terminalChannels,
} from "../../../shared/terminal";
import { assertTrustedSender, broadcast, handle } from "../ipc";
import { appHomeDir } from "../paths";
import { terminalFolder } from "../workspaces";
import { watchAgentActivity } from "./agent-activity";
import { agentBindings } from "./agent-binding";
import {
  applyAgentMarks,
  cleanAgentName,
  keptKeys,
  readAgentMarks,
  updateAgentMark,
} from "./agent-marks";
import { agentKey, listAgentSessions } from "./agent-sessions";

let host: UtilityProcess | null = null;
let nextRequest = 1;
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
 * ⚠️ Lazily. Most sessions of this app never open a terminal, and a utility
 * process holding a native module is memory nobody asked for until then.
 */
function ensureHost(): UtilityProcess {
  if (host) return host;
  const child = utilityProcess.fork(join(__dirname, "pty-host.cjs"), [], {
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
 * Where Claude and Codex keep their conversations: the user's home.
 *
 * ⚠️ A test seam guarded the way `LANEWORK_TEST_USER_DATA` is: a spec points
 * it at fixtures instead of reading the developer's own history.
 */
function agentHome(): string {
  return (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir();
}

/** Lanework's names and pins for agent conversations (FE-24, FE-25). */
function agentMarksFile(): string {
  return join(appHomeDir(), "agent-sessions.json");
}

/**
 * One transcript watcher per workspace that has been listed, restarted when
 * its folder changes (FE-25/D3).
 *
 * ⚠️ Started by the LISTING, not by a subscribe call: the rail lists a
 * project as soon as it shows it, which is exactly when its rows need to be
 * able to spin. Capped, because every project somebody has ever looked at in
 * this run would otherwise keep a watcher.
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
    // ⚠️ EVERY write, not only a turn that changed state: a new Codex's
    // first rollout can be caught before its `session_meta` is whole, and
    // the next writes of that turn are no news (FE-31/D5).
    (agent, id) => rebind(workspace, agentKey({ agent, id })),
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

/**
 * Re-check which conversation `workspace`'s agent tabs are on (FE-31/D5);
 * the host tells every window if one moved.
 *
 * ⚠️ One at a time per workspace, and at most one more queued behind it: a
 * turn writes its transcript many times a second.
 */
const rebinding = new Map<string, Set<string>>();
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
      // ⚠️ A tab on a conversation the rail has not been shown, whose
      // transcript was just written: list again. A new Codex's first write
      // is its `session_meta`, before the prompt that titles it — and the
      // rest of that turn is no news to the activity watcher, so without
      // this its row stayed "New Codex session" until something else moved.
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

/** The conversations each workspace's listing last answered (FE-31). */
const listedKeys = new Map<string, Set<string>>();

/**
 * Claude's own record of which conversation each of its processes is on
 * (FE-31): `/resume` moves a tab by changing only that, writing nothing to
 * any transcript. Watched once the host runs, for every listed workspace.
 */
let movesWatch: FSWatcher | null = null;
let movesTimer: NodeJS.Timeout | null = null;
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

/**
 * `workspace`'s tabs, each agent one on the conversation it is on NOW
 * (FE-31): a tab that moved is moved in the host too, which tells every
 * window — so the rail regroups without polling (FE-31/D5).
 *
 * ⚠️ Best effort: a folder that cannot be read keeps what the host had.
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
 * ⚠️ The same rule a resume follows: an id this workspace's own listing does
 * not have is refused, so nothing can be written about a conversation the
 * rail was never shown.
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

/** Tell the focused window the View menu asked for something. */
export function sendTerminalCommand(command: TerminalCommand): void {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(terminalChannels.command, command);
}

/**
 * Quitting with shells still running asks first (FE-19/D8).
 *
 * ⚠️ Skipped only in an unpackaged app booted by the test suite, which cannot
 * answer a native dialog — and whose quit would otherwise wait on it forever.
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
      detail: "Quitting Lanework stops them.",
    });
    if (response !== 0) return false;
  }
  await request({ t: "killAll" }, 2_000).catch(() => undefined);
  return true;
}

export function registerTerminal(devUrl?: string): void {
  // ⚠️ Not `handle()`: the port goes back to THIS sender, so the handler
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
      if (args.length < 3 || args.length > 5)
        throw new Error("A workspace and a size are required");
      const workspace = key(args[0], "workspace");
      const cols = clampGeometry(args[1], 80);
      const rows = clampGeometry(args[2], 24);
      // ⚠️ One of three names, checked here: what an agent tab types is
      // decided by the host from the name, never sent (FE-19/D8).
      const kind = args[3] ?? "shell";
      if (!isTerminalKind(kind)) throw new Error("Unknown kind of terminal");
      // ⚠️ A resume id is one this folder's listing has, for that agent —
      // not merely one shaped right (FE-23). The host checks the shape again.
      const resume = args[4];
      if (resume !== undefined) {
        if (kind === "shell" || !isAgentSessionId(resume))
          throw new Error("Unknown conversation");
        const known = await agentSessionsOf(workspace);
        if (!known.some((entry) => entry.id === resume && entry.agent === kind))
          throw new Error("That conversation is not in this project.");
      }
      const cwd = await terminalFolder(workspace);
      return request<TerminalSession>({
        t: "spawn",
        workspace,
        cwd,
        cols,
        rows,
        kind,
        resume,
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
  // ⚠️ Read in MAIN, not the pty host: listing files starts no process, and
  // the rail asks for this on every project — most of which never open a
  // terminal.
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
        // Empty is "back to the CLI's own title" (FE-24).
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
  // ⚠️ The dev launcher restarts the app with SIGTERM on every main-process
  // save, and WAITS for it to exit. Asked "a terminal is still running?",
  // that exit never came: the old build kept running, unseen, and a change
  // looked like it had done nothing. A signal is not a person quitting — in
  // an unpackaged run it stops without asking.
  if (!app.isPackaged)
    process.once("SIGTERM", () => {
      quitting = true;
      host?.kill();
      app.exit(0);
    });
}
