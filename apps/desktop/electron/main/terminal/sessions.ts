// The terminals themselves: real shells on real ptys, each with a headless
// mirror of its screen (FE-19).
//
// ⚠️ Transport-agnostic on purpose. `host.ts` wires this to Electron's message
// ports inside the utility process, and `tests/terminal-sessions.spec.ts` drives
// it directly under plain Node — which is why nothing here imports Electron.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { type IPty, spawn as spawnPty } from "@lydell/node-pty";
import * as serializeModule from "@xterm/addon-serialize";
import * as headlessModule from "@xterm/headless";
import {
  clampGeometry,
  isAgentSessionId,
  isTerminalKind,
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalHostMessage,
  type TerminalSession,
} from "../../../shared/terminal";

/**
 * A CommonJS package's exports, however it was imported.
 *
 * ⚠️ Bundled by esbuild these are plain named exports; imported as ESM under
 * Node (the tests) the xterm packages' UMD builds expose only `default`, and a
 * named import of `Terminal` is `undefined`. agents-kanban hit the same wall.
 */
function exportsOf<T>(module: T): T {
  return ((module as { default?: T }).default ?? module) as T;
}

const { Terminal: Mirror } = exportsOf(headlessModule);
const { SerializeAddon } = exportsOf(serializeModule);

/** How long a shell's output has to rest before it counts as at its prompt. */
const PROMPT_QUIET_MS = 150;
/** An agent tab types its CLI by then, prompt or not. */
const LAUNCH_DEADLINE_MS = 5_000;

/**
 * What an agent's launch line prints just before its CLI starts (FE-26): an
 * OSC nobody answers, which xterm ignores even if one ever got through.
 *
 * ⚠️ The TYPED line is echoed as text — `\033]7771…` as backslashes and
 * digits — so only the real bytes `printf` emits can match. The echo cannot
 * end the curtain early.
 */
const LAUNCH_MARK = "\x1b]7771;lanework-launched\x07";
/**
 * Output held back while waiting for the mark, at most. A shell that prints
 * this much before its prompt is saying something worth seeing.
 */
const CURTAIN_MAX = 64 * 1024;
/** If the mark never comes, the held output is shown after this long. */
const CURTAIN_DEADLINE_MS = LAUNCH_DEADLINE_MS + 10_000;

type MirrorTerminal = InstanceType<typeof Mirror>;
type Serializer = InstanceType<typeof SerializeAddon>;

/** Whoever is watching a session: one port in the app, a collector in a test. */
export interface Subscriber {
  send(message: TerminalHostMessage): void;
}

export interface ShellChoice {
  file: string;
  args: string[];
}

/**
 * The shell a terminal runs, as a LOGIN shell (FE-19/D7).
 *
 * ⚠️ `-l` is the point. A Mac app opened from the Dock inherits launchd's PATH
 * — `/usr/bin:/bin:/usr/sbin:/sbin` — so without the user's profile `bun`,
 * `claude` and everything Homebrew installed are "command not found".
 * `LANEWORK_TERMINAL_SHELL` is the tests' way to pin a plain `/bin/sh`.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
): ShellChoice {
  if (process.platform === "win32")
    return { file: env.COMSPEC || "powershell.exe", args: [] };
  const file =
    env.LANEWORK_TERMINAL_SHELL ||
    env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l"] };
}

/**
 * The environment a shell starts with: the app's, minus the app's own.
 *
 * ⚠️ `LANEWORK_*` and `ELECTRON_*` are the APP's switches — its home folder,
 * its API, `ELECTRON_RUN_AS_NODE`. A shell that inherited them would run the
 * next `lanework` or `electron` it launched against the wrong home, or not as
 * an app at all. They are deleted, not blanked: an empty value is still set.
 */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("LANEWORK_") || key.startsWith("ELECTRON_")) continue;
    out[key] = value;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.TERM_PROGRAM = "Lanework";
  // Dock-launched apps get no locale, and without one a shell treats every
  // byte past ASCII — "Dự án" — as garbage.
  if (!out.LANG && process.platform === "darwin") out.LANG = "en_US.UTF-8";
  return out;
}

interface Viewer {
  sub: Subscriber;
  /** Output held back until this viewer's snapshot has gone; null once live. */
  pending: string[] | null;
}

interface Session {
  info: TerminalSession;
  /** Order of creation, for a stable tab order within one millisecond. */
  seq: number;
  pty: IPty | null;
  mirror: MirrorTerminal;
  serializer: Serializer;
  viewers: Map<Subscriber, Viewer>;
  /** Output read since the last flush, not yet sent to anybody. */
  outbox: string;
  flushScheduled: boolean;
  cols: number;
  rows: number;
  /** An agent tab's command line, until its first view is attached. */
  launch: string | null;
  /** Waiting for the shell's prompt before typing `launch`. */
  launchTimer: NodeJS.Timeout | null;
  /** When the pty last printed anything; 0 before its first output. */
  lastOutput: number;
  /**
   * An agent tab's output before its CLI starts, held back rather than shown
   * (FE-26): the profile's noise, the prompt, the typed line. Null once the
   * CLI is running — or for a plain shell, which hides nothing.
   */
  curtain: string | null;
}

export interface SessionsOptions {
  /** Pin the shell (tests); otherwise `defaultShell()`. */
  shell?: ShellChoice;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  scrollback?: number;
  /** What an agent tab types (tests); otherwise the CLI's own name. */
  agentCommand?: (agent: TerminalAgent) => string;
}

export interface SpawnRequest {
  workspace: string;
  /** The folder to start in, or null for the home folder. */
  cwd: string | null;
  cols: number;
  rows: number;
  /** A `TerminalKind`; anything else opens a plain shell. */
  kind?: unknown;
  /** An agent conversation to continue (FE-23); ignored unless a UUID. */
  resume?: unknown;
}

/** What follows the CLI's name to continue a conversation (FE-23). */
const RESUME_ARGS: Record<TerminalAgent, (id: string) => string> = {
  claude: (id) => `--resume ${id}`,
  codex: (id) => `resume ${id}`,
};

/**
 * What follows the CLI's name to start a NEW conversation under an id chosen
 * here, for the CLIs that take one.
 *
 * ⚠️ Without it a new tab's `resume` stays null, so nothing ties it to the
 * transcript the CLI writes once somebody types — and the rail shows the tab
 * AND that transcript as two rows for one agent. Codex has no such flag.
 */
const NEW_ARGS: Partial<Record<TerminalAgent, (id: string) => string>> = {
  claude: (id) => `--session-id ${id}`,
};

export function createSessions(options: SessionsOptions = {}) {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(workspace: string) => void>();
  const limit = options.limit ?? TERMINAL_LIMITS.perWorkspace;
  const scrollback = options.scrollback ?? TERMINAL_LIMITS.scrollback;
  let seq = 0;

  const changed = (workspace: string) => {
    for (const listener of listeners) listener(workspace);
  };

  /**
   * Hand everything read since the last flush to whoever is watching.
   *
   * ⚠️ Batched per event-loop turn rather than per pty read. A flood — a build
   * log, `cat` of a big file — arrives as thousands of small reads, and one
   * port message each is what makes a renderer fall behind a shell.
   */
  function flush(session: Session) {
    session.flushScheduled = false;
    const data = session.outbox;
    if (!data) return;
    session.outbox = "";
    for (const viewer of session.viewers.values()) {
      if (viewer.pending) viewer.pending.push(data);
      else viewer.sub.send({ t: "data", id: session.info.id, data });
    }
  }

  /**
   * Show what an agent tab held back, and stop holding: the mark came, the
   * shell exited first, or it never came at all. In the last two cases the
   * held text IS the explanation — "command not found", a profile error.
   */
  function lift(session: Session, shown: string) {
    session.curtain = null;
    if (shown) record(session, shown);
  }

  function record(session: Session, data: string) {
    session.lastOutput = Date.now();
    if (session.curtain !== null) {
      const held = session.curtain + data;
      const at = held.indexOf(LAUNCH_MARK);
      if (at !== -1) {
        // ⚠️ Everything before the mark is dropped for good: it is the shell
        // getting ready, not the agent. The view starts at the CLI.
        lift(session, held.slice(at + LAUNCH_MARK.length));
        return;
      }
      if (held.length > CURTAIN_MAX) lift(session, held);
      else session.curtain = held;
      return;
    }
    // ⚠️ The mirror sees everything, watched or not: it is what a view that
    // comes back later is drawn from. xterm refuses writes past its pending
    // limit, and losing the mirror is better than losing the shell.
    try {
      session.mirror.write(data);
    } catch {
      // A mirror past its write limit; the live stream still carries it.
    }
    session.outbox += data;
    if (!session.flushScheduled) {
      session.flushScheduled = true;
      setImmediate(() => flush(session));
    }
  }

  function copy(session: Session): TerminalSession {
    return {
      ...session.info,
      exit: session.info.exit ? { ...session.info.exit } : null,
    };
  }

  function spawn(request: SpawnRequest): TerminalSession {
    // ⚠️ Counted per SIDE (FE-26): shells for the panel, agents for the main
    // view. They are separate lists on screen, so a project full of agents
    // must not be why its panel cannot open a shell.
    const agent = isTerminalKind(request.kind) && request.kind !== "shell";
    const count = [...sessions.values()].filter(
      (session) =>
        session.info.workspace === request.workspace &&
        (session.info.kind !== "shell") === agent,
    ).length;
    if (count >= limit)
      throw new Error(
        agent
          ? `A project can have at most ${limit} agents running. Stop one first.`
          : `A project can have at most ${limit} terminals. Close one first.`,
      );
    const cols = clampGeometry(request.cols, 80);
    const rows = clampGeometry(request.rows, 24);
    const shell = options.shell ?? defaultShell(options.env ?? process.env);
    const pty = spawnPty(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: request.cwd ?? homedir(),
      env: shellEnv(options.env ?? process.env),
    });
    const mirror = new Mirror({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    // ⚠️ A kind it does not know is a plain shell, not a refusal — and never
    // a command: the only lines an agent tab can type are the ones below.
    const kind = isTerminalKind(request.kind) ? request.kind : "shell";
    // ⚠️ Checked again here, not only in main: this line is typed into a
    // shell, and a UUID is hex and dashes — nothing a shell reads as syntax.
    const resumed =
      kind !== "shell" && isAgentSessionId(request.resume)
        ? request.resume
        : null;
    const named = kind !== "shell" && !resumed ? NEW_ARGS[kind] : undefined;
    const resume = resumed ?? (named ? randomUUID() : null);
    const args = resumed
      ? ` ${RESUME_ARGS[kind as TerminalAgent](resumed)}`
      : named && resume
        ? ` ${named(resume)}`
        : "";
    const session: Session = {
      info: {
        id: randomUUID(),
        workspace: request.workspace,
        kind,
        shell: basename(shell.file),
        cwd: request.cwd,
        pid: pty.pid,
        createdAt: Date.now(),
        exit: null,
        resume,
      },
      seq: seq++,
      pty,
      mirror,
      serializer,
      viewers: new Map(),
      outbox: "",
      flushScheduled: false,
      cols,
      rows,
      // ⚠️ `printf` of the mark FIRST, then the CLI: the output is held
      // back until the mark, so the prompt and this very line never show.
      // ⚠️ `exec`, so the CLI REPLACES the shell (FE-26): `/exit` or ⌃C⌃C
      // ends the session, rather than dropping somebody at a prompt they
      // never asked for. An agent here is not a terminal. `|| exit 127`
      // because an INTERACTIVE shell survives a failed `exec`: a CLI that
      // cannot start must still end the session, with its error on screen.
      launch:
        kind === "shell"
          ? null
          : `printf '\\033]7771;lanework-launched\\007'; exec ${(options.agentCommand ?? String)(kind)}${args} || exit 127\r`,
      launchTimer: null,
      lastOutput: 0,
      curtain: kind === "shell" ? null : "",
    };
    sessions.set(session.info.id, session);
    pty.onData((data) => record(session, data));
    if (session.curtain !== null) {
      // The mark never came — a shell that cannot run `printf`, a profile
      // that hangs: show what there is rather than a spinner forever.
      setTimeout(() => {
        if (session.curtain !== null) lift(session, session.curtain);
      }, CURTAIN_DEADLINE_MS).unref?.();
    }
    pty.onExit(({ exitCode, signal: raw }) => {
      // Closed from the panel: the session is already gone, and nobody is
      // waiting to be told how it ended.
      if (sessions.get(session.info.id) !== session) return;
      // node-pty reports `0` for "no signal"; the contract says null.
      const signal = raw ? raw : null;
      session.pty = null;
      session.info.exit = { code: exitCode, signal };
      // Exited before its CLI ever started: what it printed says why.
      if (session.curtain !== null) lift(session, session.curtain);
      // ⚠️ Written into the MIRROR, not only sent: a view that attaches after
      // the exit is drawn from the snapshot, and should say so too.
      record(
        session,
        `\r\n\x1b[2m[Process exited${exitCode ? ` with code ${exitCode}` : ""}]\x1b[0m\r\n`,
      );
      setImmediate(() => {
        flush(session);
        for (const viewer of session.viewers.values())
          if (!viewer.pending)
            viewer.sub.send({
              t: "exit",
              id: session.info.id,
              code: exitCode,
              signal,
            });
      });
      changed(session.info.workspace);
    });
    changed(session.info.workspace);
    return copy(session);
  }

  function resize(id: string, cols: unknown, rows: unknown) {
    const session = sessions.get(id);
    if (!session) return;
    const c = clampGeometry(cols, session.cols);
    const r = clampGeometry(rows, session.rows);
    if (c === session.cols && r === session.rows) return;
    session.cols = c;
    session.rows = r;
    try {
      session.pty?.resize(c, r);
    } catch {
      // A pty that exited between the check and the call.
    }
    session.mirror.resize(c, r);
  }

  /**
   * Start streaming a session to `sub`: its screen as it stands, then live.
   *
   * ⚠️ The ORDER is the whole design (agents-kanban learned it the hard way):
   * 1. Flush — output already read goes to those already watching; for this
   *    viewer it is in the mirror, and so in the snapshot.
   * 2. Resize to the viewer's geometry BEFORE the snapshot. Serialized at
   *    another width, the replay wraps wrong and a TUI draws garbage.
   * 3. Mark the mirror's queue with an empty write. Everything written before
   *    the mark is in the snapshot; everything read after it is held for this
   *    viewer and sent right behind the snapshot — so nothing is lost, and
   *    nothing arrives twice.
   *
   * ⚠️ A snapshot rather than a byte ring buffer. Replaying bytes breaks every
   * TUI that repaints only the cells that changed — Claude, vim, htop — while
   * the mirror has already applied them all.
   */
  function attach(sub: Subscriber, id: string, cols: unknown, rows: unknown) {
    const session = sessions.get(id);
    if (!session) return;
    flush(session);
    resize(id, cols, rows);
    const viewer: Viewer = { sub, pending: [] };
    session.viewers.set(sub, viewer);
    session.mirror.write("", () => {
      // Detached, or attached again, before the mark was reached.
      if (session.viewers.get(sub) !== viewer) return;
      let data = "";
      try {
        data = session.serializer.serialize({ scrollback });
      } catch {
        data = "";
      }
      sub.send({ t: "snapshot", id, data });
      const backlog = viewer.pending?.join("") ?? "";
      viewer.pending = null;
      if (backlog) sub.send({ t: "data", id, data: backlog });
      if (session.info.exit) sub.send({ t: "exit", id, ...session.info.exit });
      // ⚠️ An agent's CLI is typed only NOW, with a view attached, and not at
      // spawn. Claude and Codex ask the terminal for its colours (OSC 10/11)
      // as they start, and only a mounted xterm can answer — unanswered,
      // Codex waits out the question and falls back to its light theme on a
      // dark panel. agents-kanban hit exactly that.
      // ⚠️ TYPED into the shell (then `exec`ed), not spawned directly: the
      // user's login shell is what knows their PATH and aliases, so the CLI
      // is found wherever their own terminal would find it.
      launchAtPrompt(session);
    });
  }

  /**
   * Type an agent tab's CLI once its shell is sitting at a prompt.
   *
   * ⚠️ Not straight away. A login shell is still reading its profile when the
   * view attaches, and a line typed then is echoed by the terminal BEFORE the
   * prompt and drawn again after it — every Claude tab would open on
   * `claude` twice. A shell at its prompt has printed and gone quiet, so the
   * line waits for output that has rested for `PROMPT_QUIET_MS`, or for
   * `LAUNCH_DEADLINE_MS` after the spawn if a prompt never seems to settle.
   */
  function launchAtPrompt(session: Session) {
    if (!session.launch || session.launchTimer) return;
    const tick = () => {
      session.launchTimer = null;
      if (!session.launch || !session.pty) return;
      if (sessions.get(session.info.id) !== session) return;
      const now = Date.now();
      const quiet =
        session.lastOutput > 0 && now - session.lastOutput >= PROMPT_QUIET_MS;
      if (quiet || now - session.info.createdAt >= LAUNCH_DEADLINE_MS) {
        const launch = session.launch;
        session.launch = null;
        session.pty.write(launch);
        return;
      }
      session.launchTimer = setTimeout(tick, 40);
    };
    tick();
  }

  function detach(sub: Subscriber, id: string) {
    sessions.get(id)?.viewers.delete(sub);
  }

  function detachAll(sub: Subscriber) {
    for (const session of sessions.values()) session.viewers.delete(sub);
  }

  function input(id: string, data: unknown) {
    if (typeof data !== "string" || data.length > TERMINAL_LIMITS.maxInput)
      return;
    sessions.get(id)?.pty?.write(data);
  }

  /**
   * Put one workspace's tabs in the order given (FE-19, tab drag).
   *
   * ⚠️ Kept HERE rather than in a window's memory: the host is what every view
   * lists from, so an order stored anywhere else would be lost to a reload and
   * disagree between two windows. Unknown ids are ignored; a session the
   * caller did not name — spawned while the drag was in flight — goes last
   * rather than vanishing from the order.
   */
  function reorder(workspace: string, ids: unknown): boolean {
    if (!Array.isArray(ids)) return false;
    const mine = [...sessions.values()]
      .filter((session) => session.info.workspace === workspace)
      .sort((a, b) => a.seq - b.seq);
    const byId = new Map(mine.map((session) => [session.info.id, session]));
    const ordered: Session[] = [];
    for (const id of ids) {
      const session = typeof id === "string" ? byId.get(id) : undefined;
      if (session && !ordered.includes(session)) ordered.push(session);
    }
    for (const session of mine)
      if (!ordered.includes(session)) ordered.push(session);
    for (const session of ordered) session.seq = seq++;
    changed(workspace);
    return true;
  }

  /** Stop a shell and forget it. True when there was one to stop. */
  function kill(id: string): boolean {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    if (session.launchTimer) clearTimeout(session.launchTimer);
    try {
      session.pty?.kill();
    } catch {
      // Already gone.
    }
    session.pty = null;
    session.viewers.clear();
    session.mirror.dispose();
    changed(session.info.workspace);
    return true;
  }

  function killAll() {
    for (const id of [...sessions.keys()]) kill(id);
  }

  function list(workspace?: string): TerminalSession[] {
    return [...sessions.values()]
      .filter((session) => !workspace || session.info.workspace === workspace)
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }

  /** Shells still running — what quitting the app would stop. */
  function liveCount(): number {
    return [...sessions.values()].filter((session) => !session.info.exit)
      .length;
  }

  function onChanged(listener: (workspace: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    spawn,
    list,
    attach,
    detach,
    detachAll,
    input,
    resize,
    reorder,
    kill,
    killAll,
    liveCount,
    onChanged,
  };
}

export type Sessions = ReturnType<typeof createSessions>;
