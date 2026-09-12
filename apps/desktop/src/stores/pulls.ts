import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  GitAccount,
  GitAppAccess,
  GitConnectProgress,
  PullDetail,
  PullStatus,
  PullsView,
  RepoOption,
  RepoState,
  ReviewVerdict,
} from "../../shared/git";

const api = () => {
  const surface = window.desktop?.git;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * Request tickets, one per read that can be in flight twice.
 *
 * ⚠️ The same counter `stores/board.ts` carries, for the same reason: two
 * overlapping reads land in whatever order the network returns them, and
 * without a ticket the OLDER one wins. Pressing refresh while a slow failure is
 * still running is exactly how that happens.
 */
const ticket = { pulls: 0, detail: 0 };

interface PullsState {
  /** The project these fields describe. Everything below resets when it changes. */
  slug: string | null;
  /**
   * The state being listed.
   *
   * ⚠️ Held here as well as in the URL because `refresh` has to know what to ask
   * for again — a refresh that re-read "open" while the screen said "merged"
   * would replace the list with somebody else's answer.
   */
  status: PullStatus;
  /** True once the connection state has been read at least once. */
  ready: boolean;
  account: GitAccount;
  repo: RepoState | null;

  view: PullsView | null;
  loading: boolean;
  error: string | null;

  /** A device flow is running; `progress` is what the user has to act on. */
  connecting: boolean;
  progress: GitConnectProgress | null;

  /**
   * The repositories this account can reach, for the picker.
   *
   * ⚠️ `null` means "nobody has asked yet", which is not the same as "none" —
   * the picker has to be able to say "loading" on first open rather than
   * "you have no repositories".
   */
  repoOptions: RepoOption[] | null;
  repoOptionsLoading: boolean;
  repoOptionsCapped: boolean;
  repoOptionsError: string | null;
  /** Where this app is installed, for the "cannot find it" way out. Null until asked. */
  appAccess: GitAppAccess | null;

  detail: PullDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  /** The verdict being submitted, so exactly one button shows as busy. */
  reviewBusy: ReviewVerdict | null;

  /** Read the account and this project's repo, then its pull requests. */
  open: (slug: string, status: PullStatus) => Promise<void>;
  refresh: () => Promise<void>;
  connect: () => Promise<{ error?: string }>;
  cancelConnect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Point this project at a repo.
   *
   * ⚠️ Answers with the failure instead of parking it in `error`: the caller is
   * a dialog with the refused name still in the field, and "that is not a
   * repository" belongs beside it rather than in a banner on the page behind.
   */
  link: (raw: string) => Promise<{ error?: string }>;
  /** Load the repository picker's list. Safe to call again; it re-reads. */
  loadRepoOptions: () => Promise<void>;
  /**
   * Send the user to GitHub to change which repositories this app may see, then
   * re-read the list when they come back.
   *
   * ⚠️ Takes an installation id, never a URL — main builds the address. Null
   * means the page for installing it somewhere new.
   */
  openAppConfig: (installationId: number | null) => Promise<void>;
  unlink: () => Promise<void>;
  openPull: (number: number) => Promise<void>;
  review: (
    number: number,
    verdict: ReviewVerdict,
    body: string,
  ) => Promise<{ error?: string }>;
  dismiss: () => void;
  /** Listen for account changes and device-flow progress. Returns an unsubscribe. */
  watch: () => () => void;
}

export const usePulls = create<PullsState>((set, get) => ({
  slug: null,
  status: "open",
  ready: false,
  account: { kind: "none" },
  repo: null,
  view: null,
  loading: false,
  error: null,
  connecting: false,
  progress: null,
  repoOptions: null,
  repoOptionsLoading: false,
  repoOptionsCapped: false,
  repoOptionsError: null,
  appAccess: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  reviewBusy: null,

  open: async (slug, status) => {
    const state = get();
    const changed = state.slug !== slug || state.status !== status;
    // ⚠️ Everything about the previous read is dropped on the way in — for a
    // changed STATE as much as a changed project. A list left on screen while
    // another one loads is one somebody will read under the heading now above
    // it, and "merged" showing open work is the whole failure this view exists
    // to avoid.
    if (changed)
      set({
        slug,
        status,
        view: null,
        error: null,
        ...(state.slug === slug
          ? {}
          : { detail: null, detailError: null, repo: null }),
      });

    const mine = ++ticket.pulls;
    set({ loading: true });
    try {
      const [account, repo] = await Promise.all([
        api().account(),
        api().repo(slug),
      ]);
      if (mine !== ticket.pulls) return;
      set({ account, repo, ready: true });

      if (account.kind !== "connected" || repo.kind !== "linked") {
        set({ loading: false, view: null });
        return;
      }
      const view = await api().pulls(slug, status);
      if (mine !== ticket.pulls) return;
      set({ view, loading: false, error: null });
    } catch (error) {
      if (mine !== ticket.pulls) return;
      set({
        loading: false,
        ready: true,
        error: ipcMessage(error, "Could not load pull requests."),
      });
    }
  },

  refresh: async () => {
    const { slug, status, account, repo } = get();
    if (!slug || account.kind !== "connected" || repo?.kind !== "linked")
      return;
    const mine = ++ticket.pulls;
    set({ loading: true });
    try {
      const view = await api().pulls(slug, status, true);
      if (mine !== ticket.pulls) return;
      set({ view, loading: false, error: null });
    } catch (error) {
      if (mine !== ticket.pulls) return;
      set({
        loading: false,
        error: ipcMessage(error, "Could not load pull requests."),
      });
    }
  },

  connect: async () => {
    if (get().connecting) return {};
    set({ connecting: true, progress: null });
    try {
      const account = await api().connect();
      set({ account, connecting: false, progress: null });
      const { slug, status } = get();
      if (slug) await get().open(slug, status);
      return {};
    } catch (error) {
      set({ connecting: false, progress: null });
      return { error: ipcMessage(error, "Could not connect to GitHub.") };
    }
  },

  cancelConnect: async () => {
    await api()
      .cancelConnect()
      .catch(() => {});
    set({ connecting: false, progress: null });
  },

  disconnect: async () => {
    const account = await api().disconnect();
    set({ account, view: null, detail: null });
  },

  link: async (raw) => {
    const { slug } = get();
    if (!slug) return { error: "Open a project first." };
    try {
      const repo = await api().linkRepo(slug, raw);
      set({ repo });
      await get().open(slug, get().status);
      return {};
    } catch (error) {
      return { error: ipcMessage(error, "Could not connect that repository.") };
    }
  },

  loadRepoOptions: async () => {
    if (get().repoOptionsLoading) return;
    set({ repoOptionsLoading: true, repoOptionsError: null });
    try {
      const [options, access] = await Promise.all([
        api().repoOptions(),
        // ⚠️ Read together with the list, because the screen needs both at the
        // same moment: an empty list is only half an answer without "and here
        // is how to widen it".
        api()
          .appAccess()
          .catch(() => null),
      ]);
      set({
        repoOptions: options.repos,
        repoOptionsCapped: options.capped,
        repoOptionsLoading: false,
        appAccess: access,
      });
    } catch (error) {
      set({
        repoOptionsLoading: false,
        // ⚠️ The list fails on its own rather than into `error`. The panel it
        // belongs to still works — a repository can be typed — and a banner
        // over the whole screen would suggest otherwise.
        repoOptionsError: ipcMessage(
          error,
          "Could not load your repositories.",
        ),
      });
    }
  },

  openAppConfig: async (installationId) => {
    await api()
      .openAppConfig(installationId)
      .catch(() => {});
  },

  unlink: async () => {
    const { slug } = get();
    if (!slug) return;
    const repo = await api().unlinkRepo(slug);
    set({ repo, view: null, detail: null });
  },

  openPull: async (number) => {
    const { slug } = get();
    if (!slug) return;
    const mine = ++ticket.detail;
    set({ detailLoading: true, detailError: null });
    try {
      const detail = await api().pull(slug, number);
      if (mine !== ticket.detail) return;
      set({ detail, detailLoading: false });
    } catch (error) {
      if (mine !== ticket.detail) return;
      set({
        detailLoading: false,
        detail: null,
        detailError: ipcMessage(error, "Could not load that pull request."),
      });
    }
  },

  review: async (number, verdict, body) => {
    const { slug } = get();
    if (!slug) return { error: "Open a project first." };
    set({ reviewBusy: verdict });
    try {
      await api().review(slug, number, verdict, body);
      set({ reviewBusy: null });
      // The decision changes what the list says about this row, so the list is
      // re-read rather than patched from a response that carries no row.
      await get().refresh();
      await get().openPull(number);
      return {};
    } catch (error) {
      set({ reviewBusy: null });
      return { error: ipcMessage(error, "Could not submit that review.") };
    }
  },

  dismiss: () => set({ error: null, detailError: null }),

  watch: () => {
    const offAccount = api().onAccountChange((account) => {
      set({ account });
      // A credential that just died takes the list with it: what is on screen
      // was read with it, and leaving it there implies it is still current.
      if (account.kind !== "connected") set({ view: null, detail: null });
    });
    const offProgress = api().onConnectProgress((progress) =>
      set({ progress }),
    );
    return () => {
      offAccount();
      offProgress();
    };
  },
}));
