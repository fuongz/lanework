// The main process's side of the terminal (FE-19): starting the pty host,
// answering the panel's requests, and handing windows a port to it.
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
import { terminalFolder } from "../workspaces";
import { listAgentSessions } from "./agent-sessions";

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

/** The conversations `workspace`'s folder has; none without a folder here. */
async function agentSessionsOf(workspace: string): Promise<AgentSession[]> {
  const folder = await terminalFolder(workspace);
  return folder ? listAgentSessions(agentHome(), folder) : [];
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
      return request<TerminalSession[]>({ t: "list", workspace });
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
}
