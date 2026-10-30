import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { readStored, writeStored } from "#/lib/stored";
import { desktopSurface } from "#/server/desktop";
import {
  TERMINAL_LIMITS,
  type TerminalAgent,
  type TerminalKind,
  type TerminalSession,
} from "../../shared/terminal";

/**
 * Per-project revision of the tab list.
 *
 * NOTE: A list read that started before an open or a close must not land
 * after it. It would bring back the tab just closed, or drop the one just
 * opened. Every local change bumps the counter; a read checks it on return.
 */
const revision = new Map<string, number>();
const bump = (project: string) =>
  revision.set(project, (revision.get(project) ?? 0) + 1);

/** The storage key of the panel's height (percent of the content column). */
const HEIGHT_KEY = "lanework:terminal-height";
const DEFAULT_TERMINAL_HEIGHT = 40;

/**
 * The height the panel opens at: the last one somebody dragged it to.
 *
 * NOTE: Kept here, not in the panel group's saved layout. Hiding the panel
 * collapses it, the saved layout would then be the collapsed one, and a panel
 * that starts collapsed has no size to expand back to: it would open at its
 * 96px minimum every time (FE-19). The height is written only while the panel
 * is showing.
 */
function readHeight(): number {
  const saved = Number(readStored(HEIGHT_KEY));
  if (Number.isFinite(saved) && saved >= 1 && saved <= 85) return saved;
  return DEFAULT_TERMINAL_HEIGHT;
}

/**
 * Whether the panel is on screen, rather than the bar that stands in for it.
 *
 * @param project Null is never shown.
 */
export function terminalShown(
  state: Pick<TerminalState, "open" | "sessions" | "spawning">,
  project: string | null,
): boolean {
  if (!project || !state.open[project]) return false;
  // No empty panel: a project with no terminal shows the bar. The panel comes
  // up with the first terminal, which opening it starts.
  return (state.sessions[project]?.length ?? 0) > 0 || state.spawning;
}

interface TerminalState {
  /**
   * Whether each project's panel was asked for.
   *
   * Hiding it stops nothing. Whether it is on screen is
   * {@link terminalShown}, which also needs a terminal to show.
   *
   * Per project, not one flag: a panel opened in one project must not come
   * up in the next one you switch to.
   */
  open: Record<string, boolean | undefined>;
  /** The height the panel opens at, in percent of the content column. */
  height: number;
  setHeight: (height: number) => void;
  /** Each project's terminals, as the host last listed them. */
  sessions: Record<string, TerminalSession[]>;
  /** The tab each project shows. */
  active: Record<string, string | undefined>;
  error: string | null;
  /** A spawn in flight, so the + button cannot start two. */
  spawning: boolean;
  /** The agent CLIs this machine has, as last asked: what + offers. */
  agents: TerminalAgent[];
  /** The CLIs were asked for once, answered or not: the rail stops waiting. */
  agentsAsked: boolean;
  loadAgents: () => Promise<void>;
  setOpen: (project: string, open: boolean) => void;
  refresh: (project: string) => Promise<void>;
  spawn: (
    project: string,
    kind?: TerminalKind,
    resume?: string,
  ) => Promise<void>;
  close: (project: string, id: string) => Promise<void>;
  select: (project: string, id: string) => void;
  /** Move a tab dropped on another into that tab's place (drag, at drop). */
  reorderTab: (project: string, dragId: string, overId: string) => void;
  /** Move a tab one place left or right: the keyboard path for a drag. */
  moveTab: (project: string, id: string, delta: -1 | 1) => void;
  /** Mark a session whose shell exited, keeping its tab. */
  markExited: (project: string, id: string, code: number) => void;
  /**
   * View › Toggle Terminal: hide the panel, or show it.
   *
   * Showing it starts a terminal when the project has none, so the shortcut
   * always ends at a prompt.
   */
  toggle: (project: string | null) => Promise<void>;
  /** View › New Terminal: show the panel and start one. */
  newTerminal: (project: string | null) => Promise<void>;
}

/**
 * Close the panel after a start that failed and left nothing to show.
 *
 * Back to the bar, which says why, rather than a panel held open around no
 * terminal.
 */
function settle(project: string) {
  if (!(useTerminal.getState().sessions[project]?.length ?? 0))
    useTerminal.setState((state) => ({
      open: { ...state.open, [project]: false },
    }));
}

/**
 * Show a new tab order at once, then tell the host, which keeps it.
 *
 * The active tab is left alone. Dragging a tab says where it should sit, not
 * which shell you want to type into.
 */
function applyOrder(project: string, ids: string[]) {
  bump(project);
  useTerminal.setState((state) => {
    const byId = new Map(
      (state.sessions[project] ?? []).map((session) => [session.id, session]),
    );
    return {
      sessions: {
        ...state.sessions,
        [project]: ids.flatMap((id) => {
          const session = byId.get(id);
          return session ? [session] : [];
        }),
      },
    };
  });
  desktopSurface("terminal")
    .reorder(project, ids)
    .catch((error: unknown) =>
      useTerminal.setState({
        error: ipcMessage(error, "Could not move that terminal."),
      }),
    );
}

export const useTerminal = create<TerminalState>()((set, get) => ({
  open: {},
  height: readHeight(),
  sessions: {},
  active: {},
  error: null,
  spawning: false,
  agents: [],
  agentsAsked: false,

  loadAgents: async () => {
    try {
      const agents = await desktopSurface("terminal").agents();
      if (agents.join() !== get().agents.join()) set({ agents });
    } catch {
      // Not asked, or not answered: + keeps offering what it did.
    } finally {
      if (!get().agentsAsked) set({ agentsAsked: true });
    }
  },

  setOpen: (project, open) =>
    set((state) => ({
      open: { ...state.open, [project]: open },
      error: open ? state.error : null,
    })),

  setHeight: (height) => {
    if (!Number.isFinite(height) || height < 1 || height > 85) return;
    if (height === get().height) return;
    set({ height });
    writeStored(HEIGHT_KEY, String(height));
  },

  refresh: async (project) => {
    const mine = revision.get(project) ?? 0;
    try {
      // NOTE: Shells only (FE-26/D6). The host runs agents too, but they
      // belong to the main view and `useAgentTerminals` lists them. A Claude
      // started from the rail must never turn up as a tab here.
      const listed = (await desktopSurface("terminal").list(project)).filter(
        (session) => session.kind === "shell",
      );
      if ((revision.get(project) ?? 0) !== mine) return;
      set((state) => {
        const current = state.active[project];
        const keep = listed.some((session) => session.id === current);
        return {
          sessions: { ...state.sessions, [project]: listed },
          active: {
            ...state.active,
            [project]: keep ? current : listed.at(-1)?.id,
          },
        };
      });
    } catch (error) {
      set({
        error: ipcMessage(error, "Could not list this project's terminals."),
      });
    }
  },

  spawn: async (project, kind = "shell", resume) => {
    if (get().spawning) return;
    const count = get().sessions[project]?.length ?? 0;
    if (count >= TERMINAL_LIMITS.perProject) {
      set({
        error: `A project can have at most ${TERMINAL_LIMITS.perProject} terminals. Close one first.`,
      });
      return;
    }
    set({ spawning: true, error: null });
    try {
      // A first guess at the size; the view's attach sets the real one before
      // anything is drawn.
      const session = await desktopSurface("terminal").spawn(
        project,
        80,
        24,
        kind,
        resume,
      );
      bump(project);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [project]: [
            ...(state.sessions[project] ?? []).filter(
              (entry) => entry.id !== session.id,
            ),
            session,
          ],
        },
        active: { ...state.active, [project]: session.id },
      }));
    } catch (error) {
      set({ error: ipcMessage(error, "Could not start a terminal.") });
    } finally {
      set({ spawning: false });
    }
  },

  close: async (project, id) => {
    bump(project);
    set((state) => {
      const list = state.sessions[project] ?? [];
      const at = list.findIndex((session) => session.id === id);
      const rest = list.filter((session) => session.id !== id);
      const active =
        state.active[project] === id
          ? (rest[Math.min(at, rest.length - 1)]?.id ?? undefined)
          : state.active[project];
      return {
        sessions: { ...state.sessions, [project]: rest },
        active: { ...state.active, [project]: active },
        // The last one closed: back to the bar, not an empty panel.
        open: {
          ...state.open,
          [project]: rest.length > 0 && !!state.open[project],
        },
      };
    });
    try {
      await desktopSurface("terminal").kill(id);
    } catch (error) {
      set({ error: ipcMessage(error, "Could not close that terminal.") });
    }
  },

  select: (project, id) =>
    set((state) => ({ active: { ...state.active, [project]: id } })),

  reorderTab: (project, dragId, overId) => {
    const ids = (get().sessions[project] ?? []).map((session) => session.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as string);
    applyOrder(project, next);
  },

  moveTab: (project, id, delta) => {
    const ids = (get().sessions[project] ?? []).map((session) => session.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    // The ends are walls, not a wrap: a tab that jumps from last to first on
    // one press too many is a tab you then have to go and find.
    if (at === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(at, 1);
    next.splice(to, 0, moved as string);
    applyOrder(project, next);
  },

  markExited: (project, id, code) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [project]: (state.sessions[project] ?? []).map((session) =>
          session.id === id && !session.exit
            ? { ...session, exit: { code, signal: null } }
            : session,
        ),
      },
    })),

  toggle: async (project) => {
    // NOTE: What is on screen decides, not the flag. A panel asked for whose
    // project has no terminal shows as the bar, and the key must open it.
    if (!project) return;
    if (terminalShown(get(), project)) {
      get().setOpen(project, false);
      return;
    }
    set((state) => ({
      open: { ...state.open, [project]: true },
      error: null,
    }));
    await get().refresh(project);
    if (!(get().sessions[project]?.length ?? 0)) await get().spawn(project);
    settle(project);
  },

  newTerminal: async (project) => {
    if (!project) return;
    set((state) => ({ open: { ...state.open, [project]: true } }));
    await get().spawn(project);
    settle(project);
  },
}));
