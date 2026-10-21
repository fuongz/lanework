import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  CommitDiff,
  GitAccount,
  MergeMethod,
  PullActivity,
  PullCommit,
  PullDetail,
  PullFile,
  PullStatus,
  PullsView,
  RepoSide,
  RepoState,
  ReviewVerdict,
} from "../../shared/git";

/**
 * Whether there is a list to read.
 *
 * True when `gh` is signed in and the project's folder is a GitHub checkout.
 * One answer for every screen that asks, so the list, its controls and the
 * empty pane cannot disagree about whether the setup panel is showing.
 */
export function canReadPulls(
  account: GitAccount,
  repo: RepoState | null,
): boolean {
  return account.kind === "ok" && repo?.kind === "detected";
}

/**
 * What the diff and the file tree are both looking at.
 *
 * NOTE: One function, called from both, rather than each deciding. The tree
 * is a separate panel, not a child of the diff. Two independent answers to
 * "which files are on screen" give a tree listing the pull request while the
 * diff shows one commit.
 *
 * @param commit The sha the diff shows, or null for the whole pull request.
 * @returns Null while the read it needs has not landed.
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
 * NOTE: The same counter as `stores/board.ts`, for the same reason. Two
 * overlapping reads land in whatever order the network returns them, and
 * without a ticket the older one can win. Pressing refresh while a slow
 * failure is still running does it.
 */
const ticket = { pulls: 0, detail: 0, commitDiff: 0, activity: 0 };

interface PullsState {
  /**
   * The project these fields describe.
   *
   * Everything below resets when it changes.
   */
  slug: string | null;
  /**
   * The state being listed.
   *
   * NOTE: Held here as well as in the URL because `refresh` must know what to
   * ask for again. A refresh that re-read "open" while the screen said
   * "merged" would replace the list with the wrong answer.
   */
  status: PullStatus;
  /** True once the connection state has been read at least once. */
  ready: boolean;
  account: GitAccount;
  repo: RepoState | null;

  view: PullsView | null;
  loading: boolean;
  error: string | null;

  /** Whether `check` is asking `gh` again. */
  checking: boolean;

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
   * The open pull request's commits; `null` until the menu is first opened.
   *
   * "Nobody has asked yet" and "there are none" stay different: the menu says
   * "Loading…" for the first and nothing for the second.
   */
  commits: PullCommit[] | null;
  commitsLoading: boolean;
  commitsError: string | null;
  /**
   * Which commit the diff is showing, or `null` for the whole pull request.
   *
   * The default is the whole pull request, and it stays so across a refresh.
   * A review is of the change as a whole; one commit is a lens you pick up
   * and put down.
   */
  commit: string | null;
  commitDiff: CommitDiff | null;
  commitDiffLoading: boolean;
  commitDiffError: string | null;
  /**
   * The open pull request's timeline and CI.
   *
   * NOTE: Null until the Summary is opened. It carries its own `number` so a
   * stale read cannot be drawn under a different pull request. Most sessions
   * never make this read (the screen lands on the diff), so it is not part of
   * the detail read, which every open pays for.
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
   * NOTE: Carries `at` as well as the path, because picking the same file
   * twice must scroll twice. A bare path would be an unchanged value the
   * second time, and the effect watching it would not run.
   */
  focus: { path: string; at: number } | null;

  /** Read the account and this project's repo, then its pull requests. */
  open: (slug: string, status: PullStatus) => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Ask `gh` again, then re-read this project.
   *
   * The app never signs anybody in. This backs the "Check again" button
   * after somebody installs `gh` or runs `gh auth login` in a terminal.
   */
  check: () => Promise<void>;
  /**
   * Read a fork's own repo or its parent, for this session only.
   *
   * The list and the open pull request are dropped first: they belong to the
   * other repo, and a number on screen would name a different pull request.
   */
  selectRepo: (side: RepoSide) => Promise<void>;
  openPull: (number: number) => Promise<void>;
  /**
   * Read the open pull request's commits.
   *
   * Safe to call again; it re-reads.
   */
  loadCommits: (number: number) => Promise<void>;
  /**
   * Show one commit's diff, or the whole pull request.
   *
   * @param sha Null for the whole pull request.
   */
  selectCommit: (sha: string | null) => Promise<void>;
  /**
   * Read the open pull request's timeline and checks.
   *
   * Safe to call on every render of the summary: a read already answered for
   * this pull request is skipped unless `refresh` is set. The tab mounts and
   * unmounts on every switch, and each switch would otherwise cost a request.
   *
   * @param refresh Read again even when this pull request's answer is in.
   */
  loadActivity: (number: number, refresh?: boolean) => Promise<void>;
  /**
   * Leave an ordinary comment.
   *
   * Re-reads the timeline on success.
   *
   * @returns The failure, ready to show, when it did not post.
   */
  postComment: (number: number, body: string) => Promise<{ error?: string }>;
  toggleFiles: () => void;
  /**
   * Say outright whether the files panel is open.
   *
   * NOTE: Beside `toggleFiles`, not instead of it. Dragging the panel's handle
   * onto the edge reports a state. Feeding that through a toggle inverts
   * whatever the store held, and the panel and its button then disagree.
   */
  setFilesOpen: (open: boolean) => void;
  focusFile: (path: string) => void;
  review: (
    number: number,
    verdict: ReviewVerdict,
    body: string,
  ) => Promise<{ error?: string }>;
  dismiss: () => void;
  /**
   * Listen for account changes.
   *
   * @returns The unsubscribe.
   */
  watch: () => () => void;
}

export const usePulls = create<PullsState>((set, get) => ({
  slug: null,
  status: "open",
  ready: false,
  account: { kind: "logged-out" },
  repo: null,
  view: null,
  loading: false,
  error: null,
  checking: false,
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
    // NOTE: Everything about the previous read is dropped on the way in, for
    // a changed state as much as a changed project. A list left on screen
    // while another loads gets read under the new heading: "merged" showing
    // open work.
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

      if (!canReadPulls(account, repo)) {
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
    if (!slug || !canReadPulls(account, repo)) return;
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

  check: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const account = await api().check();
      set({ account });
      const { slug, status } = get();
      // The folder is read again too: "Check again" is also the way out of
      // "this folder is not a GitHub repo" after somebody adds a remote.
      if (slug) await get().open(slug, status);
    } catch (error) {
      set({ error: ipcMessage(error, "Could not run the GitHub CLI.") });
    } finally {
      set({ checking: false });
    }
  },

  selectRepo: async (side) => {
    const { slug, status } = get();
    if (!slug) return;
    set({ view: null, detail: null, detailError: null, activity: null });
    try {
      const repo = await api().selectRepo(slug, side);
      set({ repo });
    } catch (error) {
      set({ error: ipcMessage(error, "Could not switch the repository.") });
      return;
    }
    await get().open(slug, status);
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
      // NOTE: Everything about the last pull request goes with it. A commit
      // list and a selected sha belong to one pull request. Left in place,
      // they show the previous one's commits in this one's menu, and keep the
      // diff pinned to a commit that is not in it.
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
        // `commits` is left alone. A failed re-read of a list already on
        // screen must not empty the menu somebody has open.
        commitsError: ipcMessage(error, "Could not load the commits."),
      });
    }
  },

  selectCommit: async (sha) => {
    const { slug } = get();
    if (!slug) return;
    // NOTE: The ticket moves even for the whole-pull-request case, so a
    // commit read still in flight cannot land afterwards and put the screen
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
      // Re-read rather than append. Appending here would mean inventing the
      // comment's id, timestamp and author, on a row that then looks like one
      // the server sent.
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
      // A login that just ended takes the list with it: what is on screen
      // was read with it, and leaving it there implies it is still current.
      if (account.kind !== "ok") set({ view: null, detail: null });
    });
    return offAccount;
  },
}));
