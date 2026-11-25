import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { desktopSurface, findDesktopSurface } from "#/server/desktop";
import type {
  Automation,
  AutomationInput,
  AutomationRun,
} from "../../shared/automations";

/** Runs the History table reads per automation. */
const RUNS_SHOWN = 50;

/**
 * Request tickets, as in `stores/pulls.ts`: two overlapping reads land in
 * whatever order main answers them, and the older one must not win.
 */
const ticket = { list: 0, runs: new Map<string, number>() };

function byName(a: Automation, b: Automation): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

interface AutomationsState {
  /** The project these fields describe; everything resets when it changes. */
  slug: string | null;
  /** Null until the first read lands. */
  automations: Automation[] | null;
  loading: boolean;
  error: string | null;
  /** Each automation's runs, newest first; absent until read. */
  runs: Record<string, AutomationRun[]>;
  runsError: Record<string, string>;
  /**
   * The New or Edit dialog, when open: the layout draws it, so the list's
   * button, the empty state's and the detail's Edit share one.
   */
  editor: { kind: "new" } | { kind: "edit"; id: string } | null;
  openEditor: (editor: { kind: "new" } | { kind: "edit"; id: string }) => void;
  closeEditor: () => void;

  /** Read a project's automations; a new slug clears what was there. */
  open: (slug: string) => Promise<void>;
  refresh: () => Promise<void>;
  loadRuns: (id: string) => Promise<void>;
  /**
   * Follow main's changes: the list again, and the runs of the automation
   * that changed when they are on screen.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;

  /** @throws With main's message when the input is refused. */
  create: (input: AutomationInput) => Promise<Automation>;
  /** @throws With main's message when the input is refused. */
  update: (id: string, input: AutomationInput) => Promise<Automation>;
  /** @throws With main's message. */
  remove: (id: string) => Promise<void>;
  /** Flipped on screen at once, put back when main refuses. */
  setEnabled: (id: string, enabled: boolean) => Promise<{ error?: string }>;
  runNow: (id: string) => Promise<{ error?: string }>;
}

/** `automation` put into `list` in place of its old row, by name. */
function upsert(list: Automation[] | null, automation: Automation) {
  return [
    ...(list ?? []).filter((entry) => entry.id !== automation.id),
    automation,
  ].sort(byName);
}

export const useAutomations = create<AutomationsState>((set, get) => ({
  slug: null,
  automations: null,
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
        automations: null,
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
      const list = await desktopSurface("automations").list(slug);
      if (mine !== ticket.list || get().slug !== slug) return;
      set({ automations: [...list].sort(byName), error: null });
    } catch (failure) {
      if (mine !== ticket.list) return;
      set({ error: ipcMessage(failure, "Could not read the automations.") });
    } finally {
      if (mine === ticket.list) set({ loading: false });
    }
  },

  loadRuns: async (id) => {
    const mine = (ticket.runs.get(id) ?? 0) + 1;
    ticket.runs.set(id, mine);
    try {
      const runs = await desktopSurface("automations").runs(id, RUNS_SHOWN);
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
    const surface = findDesktopSurface("automations");
    if (!surface) return () => {};
    return surface.onChanged((change) => {
      if (change.project !== get().slug) return;
      void get().refresh();
      if (get().runs[change.automationId])
        void get().loadRuns(change.automationId);
    });
  },

  create: async (input) => {
    const slug = get().slug;
    if (!slug) throw new Error("No project is open.");
    try {
      const automation = await desktopSurface("automations").create(
        slug,
        input,
      );
      set({ automations: upsert(get().automations, automation) });
      return automation;
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not save the automation."));
    }
  },

  update: async (id, input) => {
    try {
      const automation = await desktopSurface("automations").update(id, input);
      set({ automations: upsert(get().automations, automation) });
      return automation;
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not save the automation."));
    }
  },

  remove: async (id) => {
    try {
      await desktopSurface("automations").remove(id);
      const { [id]: _, ...runs } = get().runs;
      set({
        automations: (get().automations ?? []).filter(
          (entry) => entry.id !== id,
        ),
        runs,
      });
    } catch (failure) {
      throw new Error(ipcMessage(failure, "Could not delete the automation."));
    }
  },

  setEnabled: async (id, enabled) => {
    const before = get().automations;
    set({
      automations:
        before?.map((entry) =>
          entry.id === id ? { ...entry, enabled } : entry,
        ) ?? null,
    });
    try {
      const automation = await desktopSurface("automations").setEnabled(
        id,
        enabled,
      );
      set({ automations: upsert(get().automations, automation) });
      return {};
    } catch (failure) {
      set({ automations: before });
      return {
        error: ipcMessage(failure, "Could not change the automation."),
      };
    }
  },

  runNow: async (id) => {
    try {
      const run = await desktopSurface("automations").runNow(id);
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
