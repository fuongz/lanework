import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import {
  type AgentSession,
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalKind,
  type TerminalSession,
} from "../../shared/terminal";

const api = () => {
  const surface = window.desktop?.terminal;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * Per-workspace revision of the tab list (FE-19).
 *
 * ⚠️ A list read that started before an open or a close must not land after
 * it — it would bring back the tab that was just closed, or drop the one just
 * opened. agents-kanban shipped exactly that race; a counter bumped by every
 * local change, and checked when the read returns, is what fixed it there.
 */
const revision = new Map<string, number>();
const bump = (workspace: string) =>
  revision.set(workspace, (revision.get(workspace) ?? 0) + 1);

/** The panel's height, as a percentage of the content column. */
const HEIGHT_KEY = "lanework:terminal-height";
export const DEFAULT_TERMINAL_HEIGHT = 40;

/**
 * The height the panel opens at: the last one somebody dragged it to.
 *
 * ⚠️ Kept HERE, not in the panel group's saved layout. Hiding the panel
 * collapses it to nothing, that collapsed layout is what got saved, and a
 * panel that starts collapsed has no size to expand back to — so it opened at
 * its 96px minimum every time (FE-19). The height is only ever written while
 * the panel is showing.
 */
function readHeight(): number {
  try {
    const saved = Number(window.localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= 1 && saved <= 85) return saved;
  } catch {
    // No storage: the default below.
  }
  return DEFAULT_TERMINAL_HEIGHT;
}

/** Whether the panel is on screen, rather than the bar that stands in for it. */
export function terminalShown(
  state: Pick<TerminalState, "open" | "sessions" | "spawning">,
  workspace: string | null,
): boolean {
  if (!state.open || !workspace) return false;
  // ⚠️ No empty panel: a project with no terminal shows the bar, and the
  // panel comes up with the first one — which opening it starts.
  return (state.sessions[workspace]?.length ?? 0) > 0 || state.spawning;
}

interface TerminalState {
  /**
   * Whether the panel was asked for. Hiding it stops nothing; on screen it is
   * `terminalShown()`, which also needs a terminal to show.
   */
  open: boolean;
  /** The height the panel opens at, in percent of the content column. */
  height: number;
  setHeight: (height: number) => void;
  /** Each workspace's terminals, as the host last listed them. */
  sessions: Record<string, TerminalSession[]>;
  /** The tab each workspace shows. */
  active: Record<string, string | undefined>;
  error: string | null;
  /** A spawn in flight, so the + button cannot start two. */
  spawning: boolean;
  /** The agent CLIs this machine has, as last asked: what + offers. */
  agents: TerminalAgent[];
  loadAgents: () => Promise<void>;
  setOpen: (open: boolean) => void;
  refresh: (workspace: string) => Promise<void>;
  spawn: (
    workspace: string,
    kind?: TerminalKind,
    resume?: string,
  ) => Promise<void>;
  /**
   * The rail's Agents group (FE-23): show the tab already resuming this
   * conversation, or open one that resumes it.
   */
  resumeAgent: (workspace: string, session: AgentSession) => Promise<void>;
  close: (workspace: string, id: string) => Promise<void>;
  select: (workspace: string, id: string) => void;
  /** A tab dropped on another: it takes that tab's place (drag, at drop). */
  reorderTab: (workspace: string, dragId: string, overId: string) => void;
  /** The keyboard path for the same move: one place left or right. */
  moveTab: (workspace: string, id: string, delta: -1 | 1) => void;
  /** The session's shell exited; keep its tab, mark it. */
  markExited: (workspace: string, id: string, code: number) => void;
  /**
   * View › Toggle Terminal: hide the panel, or show it — with a terminal
   * started when the project has none, so the shortcut always ends at a prompt.
   */
  toggle: (workspace: string | null) => Promise<void>;
  /** View › New Terminal: show the panel and start one. */
  newTerminal: (workspace: string | null) => Promise<void>;
}

/**
 * A start that failed and left nothing to show: back to the bar, which says
 * why, rather than a panel held open around no terminal.
 */
function settle(workspace: string) {
  if (!(useTerminal.getState().sessions[workspace]?.length ?? 0))
    useTerminal.setState({ open: false });
}

/**
 * Show a new tab order at once, then tell the host, which keeps it.
 *
 * ⚠️ The active tab is left alone. Dragging a tab says where it should SIT,
 * not which shell you want to type into — agents-kanban's strip keeps the same
 * contract.
 */
function applyOrder(workspace: string, ids: string[]) {
  bump(workspace);
  useTerminal.setState((state) => {
    const byId = new Map(
      (state.sessions[workspace] ?? []).map((session) => [session.id, session]),
    );
    return {
      sessions: {
        ...state.sessions,
        [workspace]: ids.flatMap((id) => {
          const session = byId.get(id);
          return session ? [session] : [];
        }),
      },
    };
  });
  api()
    .reorder(workspace, ids)
    .catch((error: unknown) =>
      useTerminal.setState({
        error: ipcMessage(error, "Could not move that terminal."),
      }),
    );
}

export const useTerminal = create<TerminalState>()((set, get) => ({
  open: false,
  height: readHeight(),
  sessions: {},
  active: {},
  error: null,
  spawning: false,
  agents: [],

  loadAgents: async () => {
    try {
      const agents = await api().agents();
      if (agents.join() !== get().agents.join()) set({ agents });
    } catch {
      // Not asked, or not answered: + keeps offering what it did.
    }
  },

  setOpen: (open) => set({ open, error: open ? get().error : null }),

  setHeight: (height) => {
    if (!Number.isFinite(height) || height < 1 || height > 85) return;
    if (height === get().height) return;
    set({ height });
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // Kept for this session only.
    }
  },

  refresh: async (workspace) => {
    const mine = revision.get(workspace) ?? 0;
    try {
      const listed = await api().list(workspace);
      if ((revision.get(workspace) ?? 0) !== mine) return;
      set((state) => {
        const current = state.active[workspace];
        const keep = listed.some((session) => session.id === current);
        return {
          sessions: { ...state.sessions, [workspace]: listed },
          active: {
            ...state.active,
            [workspace]: keep ? current : listed.at(-1)?.id,
          },
        };
      });
    } catch (error) {
      set({
        error: ipcMessage(error, "Could not list this project's terminals."),
      });
    }
  },

  spawn: async (workspace, kind = "shell", resume) => {
    if (get().spawning) return;
    const count = get().sessions[workspace]?.length ?? 0;
    if (count >= TERMINAL_LIMITS.perWorkspace) {
      set({
        error: `A project can have at most ${TERMINAL_LIMITS.perWorkspace} terminals. Close one first.`,
      });
      return;
    }
    set({ spawning: true, error: null });
    try {
      // A first guess at the size; the view's attach sets the real one before
      // anything is drawn.
      const session = await api().spawn(workspace, 80, 24, kind, resume);
      bump(workspace);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [workspace]: [
            ...(state.sessions[workspace] ?? []).filter(
              (entry) => entry.id !== session.id,
            ),
            session,
          ],
        },
        active: { ...state.active, [workspace]: session.id },
      }));
    } catch (error) {
      set({ error: ipcMessage(error, "Could not start a terminal.") });
    } finally {
      set({ spawning: false });
    }
  },

  resumeAgent: async (workspace, session) => {
    set({ open: true, error: null });
    await get().refresh(workspace);
    // ⚠️ A live tab only: one whose CLI has exited is a transcript of the
    // last run, and a click asks to carry on, not to look back (FE-23/D6).
    const existing = (get().sessions[workspace] ?? []).find(
      (entry) => entry.resume === session.id && !entry.exit,
    );
    if (existing) get().select(workspace, existing.id);
    else await get().spawn(workspace, session.agent, session.id);
    settle(workspace);
  },

  close: async (workspace, id) => {
    bump(workspace);
    set((state) => {
      const list = state.sessions[workspace] ?? [];
      const at = list.findIndex((session) => session.id === id);
      const rest = list.filter((session) => session.id !== id);
      const active =
        state.active[workspace] === id
          ? (rest[Math.min(at, rest.length - 1)]?.id ?? undefined)
          : state.active[workspace];
      return {
        sessions: { ...state.sessions, [workspace]: rest },
        active: { ...state.active, [workspace]: active },
        // The last one closed: back to the bar, not an empty panel.
        open: rest.length > 0 && state.open,
      };
    });
    try {
      await api().kill(id);
    } catch (error) {
      set({ error: ipcMessage(error, "Could not close that terminal.") });
    }
  },

  select: (workspace, id) =>
    set((state) => ({ active: { ...state.active, [workspace]: id } })),

  reorderTab: (workspace, dragId, overId) => {
    const ids = (get().sessions[workspace] ?? []).map((session) => session.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as string);
    applyOrder(workspace, next);
  },

  moveTab: (workspace, id, delta) => {
    const ids = (get().sessions[workspace] ?? []).map((session) => session.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    // The ends are walls, not a wrap: a tab that jumps from last to first on
    // one press too many is a tab you then have to go and find.
    if (at === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(at, 1);
    next.splice(to, 0, moved as string);
    applyOrder(workspace, next);
  },

  markExited: (workspace, id, code) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [workspace]: (state.sessions[workspace] ?? []).map((session) =>
          session.id === id && !session.exit
            ? { ...session, exit: { code, signal: null } }
            : session,
        ),
      },
    })),

  toggle: async (workspace) => {
    // ⚠️ What is on SCREEN decides, not the flag: a panel asked for whose
    // project has no terminal shows as the bar, and the key has to open it.
    if (terminalShown(get(), workspace)) {
      set({ open: false, error: null });
      return;
    }
    set({ open: true, error: null });
    if (!workspace) return;
    await get().refresh(workspace);
    if (!(get().sessions[workspace]?.length ?? 0)) await get().spawn(workspace);
    settle(workspace);
  },

  newTerminal: async (workspace) => {
    set({ open: true });
    if (!workspace) return;
    await get().spawn(workspace);
    settle(workspace);
  },
}));
