/**
 * The terminal panel's contract (FE-19): what the renderer may ask of the pty
 * host, and what comes back.
 *
 * ⚠️ The renderer never names a command, a shell or a folder. It names a
 * WORKSPACE, and main resolves the folder a terminal opens in from the links
 * it wrote down itself; the host picks the shell from the environment. A
 * compromised renderer can type into a terminal it was shown, which is what a
 * terminal is for — it cannot start one somewhere else.
 */

/**
 * What a tab is opened as: a plain shell, or a shell with an agent's CLI typed
 * into it (FE-19, the + menu).
 *
 * ⚠️ A NAME, never a command. The renderer picks one of these; the host maps
 * it to the one CLI it stands for, so no command line ever crosses from the
 * page (FE-19/D8).
 */
export const TERMINAL_KINDS = ["shell", "claude", "codex"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

/** The kinds that are an agent's CLI — offered only where this machine has it. */
export type TerminalAgent = Exclude<TerminalKind, "shell">;
export const TERMINAL_AGENTS: readonly TerminalAgent[] = ["claude", "codex"];

export function isTerminalKind(value: unknown): value is TerminalKind {
  return (
    typeof value === "string" &&
    (TERMINAL_KINDS as readonly string[]).includes(value)
  );
}

/** One terminal, as the panel lists it. */
export interface TerminalSession {
  id: string;
  /** The workspace it belongs to: the cloud id, or the slug when there is none. */
  workspace: string;
  /** What it was opened as; an agent tab is still a shell underneath. */
  kind: TerminalKind;
  /** The shell's name — `zsh`, `bash` — for the tab. */
  shell: string;
  /** Where it started, or null when the project has no folder here (`~`). */
  cwd: string | null;
  pid: number;
  /** Epoch ms. */
  createdAt: number;
  /** Set once the shell has exited; the tab stays until it is closed. */
  exit: { code: number; signal: number | null } | null;
}

export const TERMINAL_LIMITS = {
  /** Tabs per workspace, exited ones included — they still hold a tab. */
  perWorkspace: 8,
  /** Columns and rows are clamped to 1…this. */
  maxGeometry: 1000,
  /** Lines the host keeps per terminal, and replays on re-attach. */
  scrollback: 5000,
  /** The most one input message may carry (a paste), in characters. */
  maxInput: 256 * 1024,
} as const;

export const terminalChannels = {
  /** Renderer → main: send me a port to the pty host. */
  connect: "terminal:connect",
  /** Main → renderer: the port, as a transferred MessagePort. */
  port: "terminal:port",
  /** Main → renderer: the host went away; every session with it. */
  hostExited: "terminal:host-exited",
  list: "terminal:list",
  spawn: "terminal:spawn",
  kill: "terminal:kill",
  reorder: "terminal:reorder",
  /** Which agent CLIs this machine has, for the + menu. */
  agents: "terminal:agents",
  /** Main → renderer: a View-menu command. */
  command: "terminal:command",
} as const;

/** What the View menu can ask the panel to do. */
export type TerminalCommand = "toggle" | "new";

/** Renderer → host, over the port. */
export type TerminalClientMessage =
  | { t: "attach"; id: string; cols: number; rows: number }
  | { t: "detach"; id: string }
  | { t: "input"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number };

/** Host → renderer, over the port. */
export type TerminalHostMessage =
  /** The whole screen and scrollback of a session, once, on attach. */
  | { t: "snapshot"; id: string; data: string }
  | { t: "data"; id: string; data: string }
  | { t: "exit"; id: string; code: number; signal: number | null }
  /** A workspace's list changed: a spawn, an exit or a close. */
  | { t: "changed"; workspace: string };

export interface TerminalViewHandlers {
  /** Replaces whatever the view drew: the screen as the host holds it. */
  onSnapshot: (data: string) => void;
  onData: (data: string) => void;
  onExit: (code: number, signal: number | null) => void;
}

export interface DesktopTerminalApi {
  list: (workspace: string) => Promise<TerminalSession[]>;
  /**
   * Start a shell for `workspace`, in its project folder — with an agent's CLI
   * typed into it for an agent `kind`. The geometry is a first guess; the
   * view's attach sets the real one before anything is drawn.
   */
  spawn: (
    workspace: string,
    cols: number,
    rows: number,
    kind?: TerminalKind,
  ) => Promise<TerminalSession>;
  /**
   * The agent CLIs this machine has, asked of the user's own shell: what the
   * + menu offers beside a plain terminal. Cached for a little while.
   */
  agents: () => Promise<TerminalAgent[]>;
  /** Stop a shell and drop its tab. */
  kill: (id: string) => Promise<void>;
  /**
   * Put a workspace's tabs in this order. Kept by the HOST, so every window
   * and every reload lists them the same way; ids it does not know are
   * ignored, and a tab the list leaves out keeps its place at the end.
   */
  reorder: (workspace: string, ids: string[]) => Promise<void>;
  /**
   * Stream one session into a view. The host resizes to `cols`×`rows` FIRST,
   * then sends one snapshot, then live output. Returns the detach.
   */
  attach: (
    id: string,
    cols: number,
    rows: number,
    handlers: TerminalViewHandlers,
  ) => () => void;
  input: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  /** A workspace's sessions changed; `"*"` when every one may have. */
  onChange: (listener: (workspace: string) => void) => () => void;
  onCommand: (listener: (command: TerminalCommand) => void) => () => void;
}

/** Clamp a geometry value the way the host will. */
export function clampGeometry(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(TERMINAL_LIMITS.maxGeometry, Math.max(1, Math.round(n)));
}
