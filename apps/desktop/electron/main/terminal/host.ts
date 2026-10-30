// The pty host: the utility process every terminal lives in (FE-19/D1).
//
// NOTE: Its own process, not the main process and not the renderer. A shell
// has to outlive the view drawing it (switching projects, reloading the
// window), and a native module crashing must not take the app's main process
// down with it. The app quitting still ends it, and every shell in it.
//
// Two kinds of traffic:
// - main → here, over `process.parentPort`: requests with a `reqId` (list,
//   spawn, kill, reorder, bind, touch, agents, count, killAll), and
//   `connect`, which carries a MessagePort.
// - a renderer ↔ here, over that port: attach/detach/input/resize, and the
//   output coming back. Main made the port and handed it only to a window it
//   trusts, so what arrives on it needs its shape checked, not its sender.
import type { MessagePortMain } from "electron";
import {
  TERMINAL_AGENTS,
  type TerminalAgent,
  type TerminalClientMessage,
} from "../../../shared/terminal";
import { createAgentProbe } from "./agents";
import { createSessions, type SpawnRequest, type Subscriber } from "./sessions";

/** A request from main; the reply carries the same `reqId`. */
type Request = { reqId: number } & (
  | { t: "list"; project?: string }
  | ({ t: "spawn" } & SpawnRequest)
  | { t: "kill"; id: string }
  | { t: "reorder"; project: string; ids: unknown }
  | { t: "bind"; project: string; bindings: unknown }
  | { t: "touch"; project: string }
  | { t: "agents" }
  | { t: "killAll" }
  | { t: "count" }
);

/**
 * Whether this is a test run: only a spec sets `LANEWORK_TEST_USER_DATA`, and
 * only an unpackaged build counts. Main forks this host with
 * `--lanework-unpackaged` when `app.isPackaged` is false (`UNPACKAGED_HOST_ARG`
 * in `index.ts`); a utility process cannot ask `app` itself.
 *
 * NOTE: The test switches are honoured only then: which agent CLIs "exist",
 * and what their tabs type. A spec then neither depends on the machine having
 * Claude nor launches it. A packaged app that inherited stray `LANEWORK_*`
 * variables from a dev shell runs the real CLIs (INF-05). `LANEWORK_*` never
 * reaches a shell either way (`shellEnv`).
 */
const testing =
  process.argv.includes("--lanework-unpackaged") &&
  Boolean(process.env.LANEWORK_TEST_USER_DATA);
/** The stand-in command a test run gives `agent`, if any. */
const binOverride = (agent: TerminalAgent) =>
  testing ? process.env[`LANEWORK_${agent.toUpperCase()}_BIN`] : undefined;

const sessions = createSessions({
  agentCommand: (agent) => binOverride(agent) || agent,
  // Legacy CLI stand-ins do not implement Claude settings; bridge integration
  // tests opt in explicitly. Production always uses the default bridge.
  claudeStatusline:
    binOverride("claude") && !process.env.LANEWORK_TEST_CLAUDE_STATUSLINE
      ? () => ""
      : undefined,
});
const probeAgents = createAgentProbe();
/** Every connected window's port. */
const clients = new Set<Subscriber>();

/** The agent CLIs this machine has, or the ones a test run pins. */
function agents(): Promise<TerminalAgent[]> {
  const pinned = testing ? process.env.LANEWORK_TERMINAL_AGENTS : undefined;
  if (pinned === undefined) return probeAgents();
  const names = pinned.split(",").map((name) => name.trim());
  return Promise.resolve(
    TERMINAL_AGENTS.filter((agent) => names.includes(agent)),
  );
}

sessions.onChanged((project) => {
  process.parentPort?.postMessage({ t: "changed" });
  for (const client of clients) client.send({ t: "changed", project });
});

/**
 * Answer one request from main.
 *
 * @throws for a request of an unknown kind.
 */
function run(request: Request): unknown {
  switch (request.t) {
    case "list":
      return sessions.list(request.project);
    case "spawn":
      return sessions.spawn(request);
    case "kill":
      return sessions.kill(request.id);
    case "reorder":
      return sessions.reorder(request.project, request.ids);
    case "bind":
      return sessions.bind(request.project, request.bindings);
    case "touch":
      return sessions.touch(request.project);
    case "agents":
      return agents();
    case "killAll":
      sessions.killAll();
      return true;
    case "count":
      return sessions.liveCount();
    default:
      throw new Error("Unknown terminal request");
  }
}

/** Act on one message from a window; a message of another shape is dropped. */
function onClientMessage(sub: Subscriber, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const message = raw as TerminalClientMessage;
  if (typeof message.id !== "string") return;
  switch (message.t) {
    case "attach":
      sessions.attach(sub, message.id, message.cols, message.rows);
      break;
    case "detach":
      sessions.detach(sub, message.id);
      break;
    case "input":
      sessions.input(message.id, message.data);
      break;
    case "resize":
      sessions.resize(message.id, message.cols, message.rows);
      break;
  }
}

/** One window's port: its views, its input, and the changes it is told of. */
function wire(port: MessagePortMain) {
  const sub: Subscriber = {
    send: (message) => {
      try {
        port.postMessage(message);
      } catch {
        // The window went away mid-send; its `close` cleans up.
      }
    },
  };
  clients.add(sub);
  port.on("message", (event) => onClientMessage(sub, event.data));
  // NOTE: A reloaded or closed window only DETACHES. The shells keep running
  // for the next view to attach to: that is what this process is for.
  port.on("close", () => {
    clients.delete(sub);
    sessions.detachAll(sub);
  });
  port.start();
}

process.parentPort.on("message", (event) => {
  const message = event.data as { t?: unknown; reqId?: unknown } | null;
  if (!message || typeof message !== "object") return;
  if (message.t === "connect") {
    const [port] = event.ports;
    if (port) wire(port);
    return;
  }
  const reqId = message.reqId;
  if (typeof reqId !== "number") return;
  // Some answers take a moment (`agents` asks a shell), so every reply goes
  // out when its value is ready; main matches them up by `reqId`.
  void Promise.resolve()
    .then(() => run(message as Request))
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((reply) =>
      process.parentPort.postMessage({ t: "reply", reqId, ...reply }),
    );
});

// Belt and braces: a host that is told to exit takes its shells with it
// rather than leaving them parented to launchd.
process.on("exit", () => sessions.killAll());
