import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  CommitDiff,
  GitAccount,
  GitAppAccess,
  GitConnectProgress,
  MergeMethod,
  PullActivity,
  PullCommit,
  PullDetail,
  PullFile,
  PullStatus,
  PullsView,
  RepoOption,
  RepoState,
  ReviewVerdict,
} from "../../shared/git";

/**
 * What the diff and the file tree are BOTH looking at.
 *
 * ⚠️ One function, called from both, rather than each deciding for itself. The
 * tree is a separate panel now — it does not descend from the diff — and two
 * independent answers to "which files are on screen" is a tree listing the
 * pull request while the diff shows one commit.
 */
export function diffSource(
  commit: string | null,
  commitDiff: CommitDiff | null,
  detail: PullDetail | null,
): { files: PullFile[]; headSha: string; baseSha: string } | null {
  if (commit !== null)
    return (
      commitDiff && {
        files: commitDiff.files,
        headSha: commitDiff.headSha,
        baseSha: commitDiff.baseSha,
      }
    );
  return (
    detail && {
      files: detail.files,
      headSha: detail.headSha,
      baseSha: detail.baseSha,
    }
  );
}

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
const ticket = { pulls: 0, detail: 0, commitDiff: 0, activity: 0 };

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
  mergeMethod: MergeMethod;
  mergeBusy: boolean;
  mergeError: string | null;
  selectMergeMethod: (method: MergeMethod) => void;
  mergePull: (number: number, headSha: string) => Promise<{ error?: string }>;

  /**
   * The open pull request's commits. `null` until the menu is first opened.
   *
   * ⚠️ "Nobody has asked yet" and "there are none" have to stay different, the
   * same distinction `repoOptions` draws — the menu says "Loading…" for the
   * first and nothing at all for the second.
   */
  commits: PullCommit[] | null;
  commitsLoading: boolean;
  commitsError: string | null;
  /**
   * Which commit the diff is showing, or `null` for the whole pull request.
   *
   * ⚠️ The DEFAULT is the whole pull request, and it stays that way across a
   * refresh. A review is of the change as a whole; one commit is a lens you
   * pick up and put down.
   */
  commit: string | null;
  commitDiff: CommitDiff | null;
  commitDiffLoading: boolean;
  commitDiffError: string | null;
  /**
   * The open pull request's timeline and CI.
   *
   * ⚠️ Null until the SUMMARY is opened, and it carries its own `number` so a
   * stale read cannot be drawn under a different pull request. This is the one
   * read on this screen that most sessions never make — the screen lands on the
   * diff — so attaching it to the detail read would charge every open for it.
   */
  activity: PullActivity | null;
  activityLoading: boolean;
  activityError: string | null;
  commentBusy: boolean;

  /** Whether the file tree shares the window with the diff. */
  filesOpen: boolean;
  /**
   * The file the tree last asked the diff to show.
   *
   * ⚠️ Carries `at` as well as the path, because picking the SAME file twice
   * has to scroll twice. A bare path would be an unchanged value the second
   * time, and the effect watching it would not run.
   */
  focus: { path: string; at: number } | null;

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
  /** Read the open pull request's commits. Safe to call again; it re-reads. */
  loadCommits: (number: number) => Promise<void>;
  /** Show one commit's diff, or the whole pull request with `null`. */
  selectCommit: (sha: string | null) => Promise<void>;
  /**
   * Read the open pull request's timeline and checks.
   *
   * ⚠️ Safe to call on every render of the summary: a read already answered for
   * this pull request is skipped unless `refresh` says otherwise. The tab is
   * mounted and unmounted every time somebody switches back and forth, and a
   * request per switch is a request per switch.
   */
  loadActivity: (number: number, refresh?: boolean) => Promise<void>;
  /** Leave an ordinary comment. Re-reads the timeline on success. */
  postComment: (number: number, body: string) => Promise<{ error?: string }>;
  toggleFiles: () => void;
  /**
   * Say outright whether the files panel is open.
   *
   * ⚠️ Beside `toggleFiles` rather than instead of it. Dragging the panel's
   * handle onto the edge reports a STATE, and feeding that through a toggle
   * inverts whatever the store happened to hold — which is how a panel and
   * its button end up disagreeing about which one is right.
   */
  setFilesOpen: (open: boolean) => void;
  focusFile: (path: string) => void;
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
  mergeMethod: "merge",
  mergeBusy: false,
  mergeError: null,
  commits: null,
  commitsLoading: false,
  commitsError: null,
  commit: null,
  commitDiff: null,
  commitDiffLoading: false,
  commitDiffError: null,
  activity: null,
  activityLoading: false,
  activityError: null,
  commentBusy: false,
  filesOpen: true,
  focus: null,

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
    set({ mergeError: null });
    set({ detailLoading: true, detailError: null });
    try {
      const detail = await api().pull(slug, number);
      if (mine !== ticket.detail) return;
      // ⚠️ Everything about the LAST pull request goes with it. A commit list
      // and a selected sha belong to one pull request, and leaving them in
      // place would show the previous one's commits in this one's menu — and,
      // worse, keep the diff pinned to a commit that is not in it.
      set({
        detail,
        detailLoading: false,
        commits: null,
        commitsError: null,
        commit: null,
        commitDiff: null,
        commitDiffError: null,
        focus: null,
      });
    } catch (error) {
      if (mine !== ticket.detail) return;
      set({
        detailLoading: false,
        detail: null,
        detailError: ipcMessage(error, "Could not load that pull request."),
      });
    }
  },

  loadCommits: async (number) => {
    const { slug, commitsLoading } = get();
    if (!slug || commitsLoading) return;
    set({ commitsLoading: true, commitsError: null });
    try {
      const commits = await api().commits(slug, number);
      set({ commits, commitsLoading: false });
    } catch (error) {
      set({
        commitsLoading: false,
        // ⚠️ `commits` is left alone. A failed re-read of a list already on
        // screen must not empty the menu somebody has open.
        commitsError: ipcMessage(error, "Could not load the commits."),
      });
    }
  },

  selectCommit: async (sha) => {
    const { slug } = get();
    if (!slug) return;
    // ⚠️ The ticket moves even for the whole-pull-request case, so a commit
    // read that is still in flight cannot land afterwards and put the screen
    // back on a commit the user just left.
    const mine = ++ticket.commitDiff;
    if (sha === null) {
      set({
        commit: null,
        commitDiff: null,
        commitDiffLoading: false,
        commitDiffError: null,
        focus: null,
      });
      return;
    }
    set({
      commit: sha,
      commitDiff: null,
      commitDiffLoading: true,
      commitDiffError: null,
      focus: null,
    });
    try {
      const commitDiff = await api().commitDiff(slug, sha);
      if (mine !== ticket.commitDiff) return;
      set({ commitDiff, commitDiffLoading: false });
    } catch (error) {
      if (mine !== ticket.commitDiff) return;
      set({
        commitDiffLoading: false,
        commitDiffError: ipcMessage(error, "Could not load that commit."),
      });
    }
  },

  loadActivity: async (number, refresh = false) => {
    const { slug, activity, activityLoading } = get();
    if (!slug) return;
    if (!refresh && activity?.number === number) return;
    if (activityLoading && activity?.number === number) return;
    const mine = ++ticket.activity;
    set({ activityLoading: true, activityError: null });
    try {
      const next = await api().activity(slug, number);
      if (mine !== ticket.activity) return;
      set({ activity: next, activityLoading: false });
    } catch (error) {
      if (mine !== ticket.activity) return;
      set({
        activityLoading: false,
        activityError: ipcMessage(error, "Could not load this activity."),
      });
    }
  },

  postComment: async (number, body) => {
    const { slug } = get();
    if (!slug) return { error: "Open a project first." };
    set({ commentBusy: true });
    try {
      await api().comment(slug, number, body);
      // ⚠️ Re-read rather than append. Writing the comment into the timeline
      // here would mean inventing its id, its timestamp and its author — three
      // things that would each be wrong in their own way, on a row that then
      // looks exactly like one the server sent.
      await get().loadActivity(number, true);
      set({ commentBusy: false });
      return {};
    } catch (error) {
      set({ commentBusy: false });
      return { error: ipcMessage(error, "Could not post that comment.") };
    }
  },

  toggleFiles: () => set((state) => ({ filesOpen: !state.filesOpen })),
  setFilesOpen: (filesOpen) => set({ filesOpen }),

  focusFile: (path) => set({ focus: { path, at: Date.now() } }),

  selectMergeMethod: (mergeMethod) => set({ mergeMethod, mergeError: null }),

  mergePull: async (number, headSha) => {
    const { slug, detail, detailLoading, mergeMethod, mergeBusy, account } =
      get();
    if (mergeBusy) return { error: "A merge is already in progress." };
    if (
      !slug ||
      detailLoading ||
      detail?.pull.number !== number ||
      detail.headSha !== headSha
    )
      return { error: "Refresh this pull request before merging." };
    const eligibility = detail.merge;
    if (
      detail.pull.state !== "open" ||
      detail.pull.draft ||
      !eligibility?.canMerge ||
      eligibility.mergeable !== true ||
      !["clean", "unstable", "has_hooks"].includes(eligibility.state ?? "") ||
      !eligibility.methods.includes(mergeMethod)
    )
      return {
        error: "This pull request is not ready to merge. Refresh its status.",
      };
    const identity = ticket.detail;
    const current = () =>
      get().slug === slug &&
      ticket.detail === identity &&
      get().account === account;
    set({ mergeBusy: true, mergeError: null });
    try {
      await api().merge(slug, number, mergeMethod, headSha);
    } catch (error) {
      const message = ipcMessage(error, "Could not merge this pull request.");
      set({ mergeBusy: false, ...(current() ? { mergeError: message } : {}) });
      return { error: message };
    }
    // The write succeeded. Read failures must never invite a second merge.
    if (current()) {
      set({ detail: { ...detail, pull: { ...detail.pull, state: "merged" } } });
      await get().refresh();
      if (current()) {
        const mine = ++ticket.detail;
        const [next, activity] = await Promise.allSettled([
          api().pull(slug, number),
          api().activity(slug, number),
        ]);
        if (
          get().slug === slug &&
          ticket.detail === mine &&
          get().account === account
        ) {
          set({
            ...(next.status === "fulfilled" ? { detail: next.value } : {}),
            ...(activity.status === "fulfilled"
              ? { activity: activity.value, activityError: null }
              : {}),
          });
        }
      }
    }
    set({ mergeBusy: false });
    return {};
  },

  review: async (number, verdict, body) => {
    const { slug, detail, reviewBusy, account } = get();
    const identity = ticket.detail;
    const current = () =>
      get().slug === slug &&
      ticket.detail === identity &&
      get().account === account;
    if (!slug) return { error: "Open a project first." };
    if (reviewBusy) return { error: "A review is already in progress." };
    if (verdict !== "COMMENT" && detail?.pull.authored)
      return {
        error: "GitHub does not allow reviewing your own pull request.",
      };
    if (verdict !== "APPROVE" && !body.trim())
      return { error: "Enter a review note first." };
    set({ reviewBusy: verdict });
    try {
      await api().review(slug, number, verdict, body);
      set({ reviewBusy: null });
      // The decision changes what the list says about this row, so the list is
      // re-read rather than patched from a response that carries no row.
      if (current()) await get().refresh();
      if (current()) {
        await get().loadActivity(number, true);
        if (current()) await get().openPull(number);
      }
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
