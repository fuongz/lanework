import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  BranchList,
  CommitChange,
  CommitMode,
  CommitSummary,
  SyncAction,
  WorktreePatch,
  WorktreeState,
} from "../../shared/worktree";

/**
 * The local repository's Changes and History screens (FE-22).
 *
 * ⚠️ Refreshed on entry, on window focus, after every action and on request —
 * never on a timer and not by a file watcher (FE-22/D10). A folder somebody is
 * editing in another app changes when they come back to this one, which is
 * exactly when the focus refresh runs.
 */

const api = () => {
  const surface = window.desktop?.worktree;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

export type DiffStyle = "split" | "unified";

const STYLE_KEY = "lanework:diff-style";

/**
 * A per-viewer convenience, so storage failing only costs the default.
 *
 * ⚠️ Unified by default (owner, 2026-09-26 — replacing FE-22/D4's Split): one
 * column reads the way a commit is read, and Split stays one click away.
 */
function readStyle(): DiffStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/**
 * Tickets, so a slow answer about one project cannot land on another.
 *
 * ⚠️ Per read, not one for the store. A status refresh finishing late must not
 * throw away the patch that was asked for after it.
 */
const ticket = { status: 0, patch: 0, history: 0, commit: 0, branches: 0 };

interface WorktreeStore {
  slug: string | null;
  state: WorktreeState | null;
  loading: boolean;
  /** Why the last read failed, or null. */
  error: string | null;
  /** The action running now, by name, so its button can say so. */
  busy: string | null;
  /** Why the last ACTION failed — separate from `error`, which is a read. */
  actionError: string | null;
  patch: WorktreePatch | null;
  patchError: string | null;
  /** The file the list last pointed at; `at` moves so the same file scrolls again. */
  focus: { path: string; at: number } | null;
  diffStyle: DiffStyle;
  message: string;

  history: CommitSummary[];
  historyMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
  commit: CommitChange | null;
  commitError: string | null;
  /**
   * The rail's branch switcher, by project.
   *
   * ⚠️ Kept apart from `state`: the rail shows the branch on every screen, and
   * reading it is `for-each-ref`, not a full `git status` — the status belongs
   * to the Changes screen, which is the one that needs the files.
   */
  branches: { slug: string; list: BranchList | null } | null;
  switching: string | null;
  switchError: string | null;

  open: (slug: string) => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Read the status alone — no patch — for the rail's `+/−` badge.
   *
   * ⚠️ Yields to a full `refresh`: if one is running, or starts while this one
   * is out, this answer is dropped rather than landing on top of a newer one.
   */
  peek: (slug: string) => Promise<void>;
  focusFile: (path: string) => void;
  setDiffStyle: (style: DiffStyle) => void;
  setMessage: (message: string) => void;
  clearActionError: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  restore: (paths: string[]) => Promise<void>;
  commitChanges: (mode: CommitMode, fallback: string) => Promise<boolean>;
  /** Fetch, pull or push; `remote` for Fetch From and Push To. The action's name is `busy`. */
  sync: (action: SyncAction, remote?: string) => Promise<void>;
  openHistory: (slug: string) => Promise<void>;
  moreHistory: () => Promise<void>;
  openCommit: (slug: string, sha: string) => Promise<void>;
  loadBranches: (slug: string) => Promise<void>;
  switchBranch: (slug: string, name: string) => Promise<boolean>;
}

export const useWorktree = create<WorktreeStore>((set, get) => {
  async function loadPatch() {
    const { slug, state } = get();
    if (!slug || state?.kind !== "ready") {
      set({ patch: null, patchError: null });
      return;
    }
    const mine = ++ticket.patch;
    try {
      const patch = await api().patch(slug);
      if (mine !== ticket.patch) return;
      set({ patch, patchError: null });
    } catch (error) {
      if (mine !== ticket.patch) return;
      set({ patchError: ipcMessage(error, "The diff could not be read.") });
    }
  }

  /** Run one write, take the status it answers, then re-read the patch. */
  async function act(
    name: string,
    call: (slug: string) => Promise<WorktreeState>,
  ): Promise<boolean> {
    const { slug, busy } = get();
    if (!slug || busy) return false;
    set({ busy: name, actionError: null });
    try {
      const state = await call(slug);
      if (get().slug !== slug) return false;
      ticket.status++;
      set({ state, busy: null, error: null });
      await loadPatch();
      return true;
    } catch (error) {
      if (get().slug !== slug) return false;
      set({
        busy: null,
        actionError: ipcMessage(error, "That did not work."),
      });
      // The action may have half-happened — a hook that failed after staging —
      // so what is on screen is re-read rather than trusted.
      void get().refresh();
      return false;
    }
  }

  return {
    slug: null,
    state: null,
    loading: false,
    error: null,
    busy: null,
    actionError: null,
    patch: null,
    patchError: null,
    focus: null,
    diffStyle: readStyle(),
    message: "",
    history: [],
    historyMore: false,
    historyLoading: false,
    historyError: null,
    commit: null,
    commitError: null,
    branches: null,
    switching: null,
    switchError: null,

    open: async (slug) => {
      if (get().slug !== slug)
        set({
          slug,
          state: null,
          patch: null,
          focus: null,
          message: "",
          error: null,
          actionError: null,
        });
      await get().refresh();
    },

    refresh: async () => {
      const { slug } = get();
      if (!slug) return;
      const mine = ++ticket.status;
      set({ loading: true });
      try {
        const state = await api().status(slug);
        if (mine !== ticket.status) return;
        set({ state, loading: false, error: null });
        await loadPatch();
      } catch (error) {
        if (mine !== ticket.status) return;
        set({
          loading: false,
          error: ipcMessage(error, "The repository could not be read."),
        });
      }
    },

    peek: async (slug) => {
      if (get().slug !== slug)
        set({
          slug,
          state: null,
          patch: null,
          focus: null,
          message: "",
          error: null,
          actionError: null,
        });
      if (get().loading) return;
      const seen = ticket.status;
      try {
        const state = await api().status(slug);
        if (seen !== ticket.status || get().slug !== slug || get().loading)
          return;
        set({ state, error: null });
      } catch {
        // The badge simply stays away; the Changes screen says why when opened.
      }
    },

    focusFile: (path) => set({ focus: { path, at: Date.now() } }),

    setDiffStyle: (diffStyle) => {
      set({ diffStyle });
      try {
        localStorage.setItem(STYLE_KEY, diffStyle);
      } catch {
        // Remembering is a convenience; the toggle already happened.
      }
    },

    setMessage: (message) => set({ message }),
    clearActionError: () => set({ actionError: null }),

    stage: async (paths) => {
      await act("stage", (slug) => api().stage(slug, paths));
    },
    unstage: async (paths) => {
      await act("unstage", (slug) => api().unstage(slug, paths));
    },
    restore: async (paths) => {
      await act("restore", (slug) => api().restore(slug, paths));
    },

    commitChanges: async (mode, fallback) => {
      // ⚠️ The placeholder IS the message when the box is empty (FE-22/D9) — it
      // is what the button promised, and committing nothing would be a refusal
      // nobody asked for.
      const message = get().message.trim() || fallback;
      const done = await act("commit", (slug) =>
        api().commit(slug, message, mode),
      );
      if (done) {
        set({ message: "" });
        // A new commit is the top of History; drop the old first page so the
        // next visit reads it again rather than showing it missing.
        ticket.history++;
        set({ history: [], historyMore: false });
      }
      return done;
    },

    sync: async (action, remote) => {
      const done = await act(action, (slug) =>
        api().sync(slug, action, remote ?? null),
      );
      // A pull brings commits in; History's first page is read again on its
      // next visit rather than shown without them.
      if (done && (action === "pull" || action === "pull-rebase")) {
        ticket.history++;
        set({ history: [], historyMore: false });
      }
    },

    openHistory: async (slug) => {
      const mine = ++ticket.history;
      if (get().slug !== slug) set({ slug, state: null, patch: null });
      set({ historyLoading: true, historyError: null });
      try {
        const page = await api().log(slug, 0);
        if (mine !== ticket.history) return;
        set({
          history: page.commits,
          historyMore: page.more,
          historyLoading: false,
        });
      } catch (error) {
        if (mine !== ticket.history) return;
        set({
          historyLoading: false,
          historyError: ipcMessage(error, "The history could not be read."),
        });
      }
    },

    moreHistory: async () => {
      const { slug, history, historyMore, historyLoading } = get();
      if (!slug || !historyMore || historyLoading) return;
      const mine = ++ticket.history;
      set({ historyLoading: true });
      try {
        const page = await api().log(slug, history.length);
        if (mine !== ticket.history) return;
        set({
          history: [...history, ...page.commits],
          historyMore: page.more,
          historyLoading: false,
        });
      } catch (error) {
        if (mine !== ticket.history) return;
        set({
          historyLoading: false,
          historyError: ipcMessage(error, "The history could not be read."),
        });
      }
    },

    openCommit: async (slug, sha) => {
      const mine = ++ticket.commit;
      if (get().commit?.commit.sha !== sha)
        set({ commit: null, commitError: null });
      try {
        const commit = await api().show(slug, sha);
        if (mine !== ticket.commit) return;
        set({ commit, commitError: null });
      } catch (error) {
        if (mine !== ticket.commit) return;
        set({
          commitError: ipcMessage(error, "That commit could not be read."),
        });
      }
    },

    loadBranches: async (slug) => {
      const mine = ++ticket.branches;
      try {
        const list = await api().branches(slug);
        if (mine !== ticket.branches) return;
        set({ branches: { slug, list } });
      } catch {
        // No branch to show is the honest answer; the rail keeps its label.
        if (mine !== ticket.branches) return;
        set({ branches: { slug, list: null } });
      }
    },

    switchBranch: async (slug, name) => {
      if (get().switching) return false;
      set({ switching: name, switchError: null });
      try {
        const state = await api().switchBranch(slug, name);
        set({ switching: null });
        await get().loadBranches(slug);
        // ⚠️ Another branch is another working tree and another history. What
        // the screens hold for this project is dropped and read again, not
        // patched — a diff from the old branch under the new name would lie.
        if (get().slug === slug) {
          ticket.status++;
          ticket.history++;
          set({
            state,
            focus: null,
            history: [],
            historyMore: false,
            commit: null,
          });
          await loadPatch();
          void get()
            .openHistory(slug)
            .catch(() => {});
        }
        return true;
      } catch (error) {
        set({
          switching: null,
          switchError: ipcMessage(
            error,
            "That branch could not be checked out.",
          ),
        });
        return false;
      }
    },
  };
});

/** The files a list row stands for — one file, or everything under a folder. */
export function stagedTally(
  files: { staged: "none" | "partial" | "full" }[],
): "none" | "partial" | "full" {
  if (!files.length) return "none";
  const full = files.filter((file) => file.staged === "full").length;
  if (full === files.length) return "full";
  return full > 0 || files.some((file) => file.staged === "partial")
    ? "partial"
    : "none";
}
