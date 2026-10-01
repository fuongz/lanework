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
  /**
   * The agent conversation this tab is on NOW (FE-31): the one it resumed
   * (FE-23), or a new Claude tab's `--session-id` — then kept up to date by
   * main as the CLI moves (`/clear`, `/resume`, a new Codex's first rollout).
   * Null for a shell, or a new Codex tab nobody has typed into yet.
   */
  resume: string | null;
}

/**
 * One conversation an agent's CLI kept on disk for a project's folder (FE-23):
 * what the rail's Agents group lists, and what a click resumes.
 */
export interface AgentSession {
  /** The CLI's own conversation id — always a UUID (`isAgentSessionId`). */
  id: string;
  agent: TerminalAgent;
  /** What the rail shows: the name given in Lanework, else `cliTitle`. */
  title: string;
  /**
   * Its title as the CLI named it, or its first prompt (FE-23). Kept beside
   * `title` so a rename can be undone back to it (FE-24).
   */
  cliTitle: string;
  /** When it was last written to, ISO. */
  updatedAt: string;
  /** When it was pinned, epoch ms, or null (FE-25). */
  pinnedAt: number | null;
  /**
   * Whether its agent is thinking or working right now: a turn is open in
   * the transcript (FE-25). Not "was written lately" — opening a
   * conversation writes to it too.
   */
  working: boolean;
  /**
   * The card its agent last named to the Lanework MCP — read only while it is
   * working, null otherwise or when it never named one (FE-27).
   */
  card: AgentCard | null;
  /** The agents it spawned, newest first (FE-33); none for most. */
  subagents: AgentSubagent[];
}

/**
 * An agent a conversation spawned (FE-33): a Claude sub-agent, or a thread a
 * Codex conversation spawned. Shown under its conversation's row.
 *
 * ⚠️ Never resumed on its own — a Claude sub-agent is a sidechain of its
 * conversation — so its id is a key for the rail and never reaches a command
 * line. Nested ones are flattened under the conversation at the root
 * (FE-33/D6).
 */
export interface AgentSubagent {
  /** Unique within its conversation: Claude's `agent-<id>`, a Codex thread id. */
  id: string;
  /** What it was asked to do, as its spawner described it. */
  title: string;
  /** Its kind as the CLI names it — `Explore`, `general-purpose` — or null. */
  type: string | null;
  /** When it was last written to, ISO. */
  updatedAt: string;
  /** Whether it is still going: its last word is not a finished answer. */
  working: boolean;
}

/**
 * A card an agent is on, as its latest Lanework MCP call named it (FE-27/D1).
 *
 * ⚠️ `card` is what the AGENT typed — a task id (`FE-27`) or a card's uuid —
 * so a renderer matches it against both, and only on the board `boardId`
 * names. Read from the agent's own transcript; nothing is asked of the cloud.
 */
export interface AgentCard {
  boardId: string;
  card: string;
}

/**
 * A transcript changed, and this is whether its agent is now working
 * (FE-25): a turn opened or closed.
 *
 * ⚠️ Pushed by main from a file watcher, never polled — the id straight from
 * the file's name, the state from the transcript's end, so marking a row
 * does not re-read the listing.
 */
export interface AgentActivity {
  workspace: string;
  agent: TerminalAgent;
  id: string;
  working: boolean;
  /** The card it is on, as `AgentSession.card` (FE-27). */
  card: AgentCard | null;
  /**
   * Set when it is one of `id`'s sub-agents that was written, not `id`
   * itself (FE-33): `working` is then that sub-agent's, and `card` null.
   */
  subagent: string | null;
  /** Epoch ms. */
  at: number;
}
/** The longest name a session may be given in Lanework. */
export const AGENT_NAME_MAX = 120;

export const AGENT_SESSION_LIMIT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can be put on a command line as a conversation id.
 *
 * ⚠️ The only shape a resume id may take: it is TYPED into a shell, so
 * anything but hex and dashes would be a way to type something else.
 */
export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
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
  /** The agent conversations kept for a workspace's folder (FE-23). */
  agentSessions: "terminal:agent-sessions",
  /** Name a conversation in Lanework only (FE-24/D1). */
  agentSessionRename: "terminal:agent-sessions:rename",
  /** Pin a conversation to the top of the group, or unpin it (FE-25). */
  agentSessionPin: "terminal:agent-sessions:pin",
  /** Main → renderer: a transcript was written (FE-25). */
  agentActivity: "terminal:agent-activity",
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
   *
   * `resume` names one of `agentSessions(workspace)` to continue (FE-23); main
   * refuses an id that listing does not have.
   */
  spawn: (
    workspace: string,
    cols: number,
    rows: number,
    kind?: TerminalKind,
    resume?: string,
  ) => Promise<TerminalSession>;
  /**
   * The Claude and Codex conversations kept for `workspace`'s folder, newest
   * first; empty when the project has no folder here.
   */
  agentSessions: (workspace: string) => Promise<AgentSession[]>;
  /**
   * Give a conversation a name in Lanework (FE-24). The CLI's files are never
   * touched; an empty name goes back to the CLI's own title. Answers the new
   * listing. Main refuses an id that `agentSessions(workspace)` does not have.
   */
  renameAgentSession: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
    name: string,
  ) => Promise<AgentSession[]>;
  /** Pin or unpin a conversation (FE-25). Answers the new listing. */
  pinAgentSession: (
    workspace: string,
    agent: TerminalAgent,
    id: string,
    pinned: boolean,
  ) => Promise<AgentSession[]>;
  onAgentActivity: (listener: (activity: AgentActivity) => void) => () => void;
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
  /**
   * The absolute path of a file dropped on a view. Only the preload can read
   * it (`webUtils`); a dropped `File` no longer carries `.path`.
   */
  pathForFile: (file: File) => string;
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
