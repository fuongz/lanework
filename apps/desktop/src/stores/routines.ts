import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { desktopSurface, findDesktopSurface } from "#/server/desktop";
import type { Routine, RoutineInput, RoutineRun } from "../../shared/routines";

/** Runs the History table reads per routine. */
const RUNS_SHOWN = 50;

/**
 * Request tickets, as in `stores/pulls.ts`: two overlapping reads land in
 * whatever order main answers them, and the older one must not win.
 */
const ticket = { list: 0, runs: new Map<string, number>() };

function byName(a: Routine, b: Routine): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

interface RoutinesState {
  /** The project these fields describe; everything resets when it changes. */
  slug: string | null;
  /** Null until the first read lands. */
  routines: Routine[] | null;
  loading: boolean;
  error: string | null;
  /** Each routine's runs, newest first; absent until read. */
  runs: Record<string, RoutineRun[]>;
  runsError: Record<string, string>;
  /**
   * The New or Edit dialog, when open: the layout draws it, so the list's
   * button, the empty state's and the detail's Edit share one.
   */
  editor: { kind: "new" } | { kind: "edit"; id: string } | null;
  openEditor: (editor: { kind: "new" } | { kind: "edit"; id: string }) => void;
  closeEditor: () => void;

  /** Read a project's routines; a new slug clears what was there. */
  open: (slug: string) => Promise<void>;
  refresh: () => Promise<void>;
  loadRuns: (id: string) => Promise<void>;
  /**
   * Follow main's changes: the list again, and the runs of the routine
   * that changed when they are on screen.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;

  /** @throws With main's message when the input is refused. */
  create: (input: RoutineInput) => Promise<Routine>;
  /** @throws With main's message when the input is refused. */
  update: (id: string, input: RoutineInput) => Promise<Routine>;
  /** @throws With main's message. */
  remove: (id: string) => Promise<void>;
  /** Flipped on screen at once, put back when main refuses. */
  setEnabled: (id: string, enabled: boolean) => Promise<{ error?: string }>;
  runNow: (id: string) => Promise<{ error?: string }>;
}

/** `routine` put into `list` in place of its old row, by name. */
function upsert(list: Routine[] | null, routine: Routine) {
  return [
    ...(list ?? []).filter((entry) => entry.id !== routine.id),
    routine,
  ].sort(byName);
}

export const useRoutines = create<RoutinesState>((set, get) => ({
  slug: null,
  routines: null,
  loading: false,
  error: null,
  runs: {},
  runsError: {},
  editor: null,
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),

  open: async (slug) => {
    if (get().slug !== slug)
      set({
        slug,
        routines: null,
        error: null,
        runs: {},
        runsError: {},
        editor: null,
      });
    await get().refresh();
  },

  refresh: async () => {
    const slug = get().slug;
    if (!slug) return;
    const mine = ++ticket.list;
    set({ loading: true });
    try {
      const list = await desktopSurface("routines").list(slug);
      if (mine !== ticket.list || get().slug !== slug) return;
      set({ routines: [...list].sort(byName), error: null });
    } catch (failure) {
      if (mine !== ticket.list) return;
      set({ error: ipcMessage(failure, "Could not read the routines.") });
    } finally {
      if (mine === ticket.list) set({ loading: false });
    }
  },

  loadRuns: async (id) => {
    const mine = (ticket.runs.get(id) ?? 0) + 1;
    ticket.runs.set(id, mine);
    try {
      const runs = await desktopSurface("routines").runs(id, RUNS_SHOWN);
      if (ticket.runs.get(id) !== mine) return;
      const { [id]: _, ...rest } = get().runsError;
      set({ runs: { ...get().runs, [id]: runs }, runsError: rest });
    } catch (failure) {
      if (ticket.runs.get(id) !== mine) return;
      set({
        runsError: {
          ...get().runsError,
          [id]: ipcMessage(failure, "Could not read the runs."),
        },
      });
    }
  },

  watch: () => {
    const surface = findDesktopSurface("routines");
    if (!surface) return () => {};
    return surface.onChanged((change) => {
      if (change.project !== get().slug) return;
      void get().refresh();
      if (get().runs[change.routineId]) void get().loadRuns(change.routineId);
    });
  },

  create: async (input) => {
    const slug = get().slug;
    if (!slug) throw new Error("No project is open.");
    try {
      const routine = await desktopSurface("routines").create(slug, input);
      set({ routines: upsert(get().routines, routine) });
      return routine;
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not save the routine."));
    }
  },

  update: async (id, input) => {
    try {
      const routine = await desktopSurface("routines").update(id, input);
      set({ routines: upsert(get().routines, routine) });
      return routine;
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not save the routine."));
    }
  },

  remove: async (id) => {
    try {
      await desktopSurface("routines").remove(id);
      const { [id]: _, ...runs } = get().runs;
      set({
        routines: (get().routines ?? []).filter((entry) => entry.id !== id),
        runs,
      });
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not delete the routine."));
    }
  },

  setEnabled: async (id, enabled) => {
    const before = get().routines;
    set({
      routines:
        before?.map((entry) =>
          entry.id === id ? { ...entry, enabled } : entry,
        ) ?? null,
    });
    try {
      const routine = await desktopSurface("routines").setEnabled(id, enabled);
      set({ routines: upsert(get().routines, routine) });
      return {};
    } catch (failure) {
      set({ routines: before });
      return {
        error: ipcMessage(failure, "Could not change the routine."),
      };
    }
  },

  runNow: async (id) => {
    try {
      const run = await desktopSurface("routines").runNow(id);
      // On screen at once; the change event reads the whole list again.
      const current = get().runs[id] ?? [];
      set({
        runs: {
          ...get().runs,
          [id]: [run, ...current.filter((entry) => entry.id !== run.id)],
        },
      });
      return {};
    } catch (failure) {
      return { error: ipcMessage(failure, "Could not start a run.") };
    }
  },
}));
