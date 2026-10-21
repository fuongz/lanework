import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  GitAccount,
  GitHubIssueDetail,
  GitHubIssuesView,
  RepoState,
} from "../../shared/git";

/**
 * Why a project's GitHub issues cannot be read (FE-75).
 *
 * The first five come from `gh` and the project's folder, and each has its
 * own way out. `failed` is a read that was allowed and still did not answer.
 */
export type GitHubIssuesProblem =
  | { kind: "missing" }
  | { kind: "logged-out" }
  | { kind: "unreachable" }
  | { kind: "no-folder" }
  | { kind: "not-github" }
  | { kind: "failed"; message: string };

/**
 * What blocks the read, or null when `gh` is signed in on a GitHub checkout.
 *
 * NOTE: The same test as `canReadPulls`, answered as a reason rather than a
 * yes or no, because the empty state has to say which step is missing.
 */
function problemOf(
  account: GitAccount,
  repo: RepoState,
): GitHubIssuesProblem | null {
  if (account.kind !== "ok") return { kind: account.kind };
  if (repo.kind !== "detected") return { kind: repo.kind };
  return null;
}

/**
 * The sentence a problem is shown with, and the command that fixes it.
 *
 * NOTE: Here rather than in a component, because the list and the issue page
 * both draw it and the layout law puts a component used twice in `shared/`.
 * The wording follows the pull requests' `ConnectPanel`.
 */
export function describeIssuesProblem(problem: GitHubIssuesProblem): {
  title: string;
  description: string;
  command: string | null;
  /** Whether "Check again" can change the answer. */
  checkable: boolean;
} {
  switch (problem.kind) {
    case "missing":
      return {
        title: "Install the GitHub CLI",
        description:
          "GitHub issues are read through the GitHub CLI (gh), with your own login. Install it, then check again.",
        command: "brew install gh",
        checkable: true,
      };
    case "logged-out":
      return {
        title: "Sign in to the GitHub CLI",
        description:
          "gh is installed but not signed in. Run this in a terminal and follow its prompts, then check again.",
        command: "gh auth login",
        checkable: true,
      };
    case "unreachable":
      return {
        title: "Can't reach GitHub",
        description:
          "gh is installed, but GitHub did not answer. Check your connection, then check again.",
        command: null,
        checkable: true,
      };
    case "no-folder":
      return {
        title: "No folder for this project",
        description:
          "GitHub issues are read from the repo in the project's folder. Link a folder on this machine in Settings › Project › General.",
        command: null,
        checkable: false,
      };
    case "not-github":
      return {
        title: "Not a GitHub repo",
        description:
          "This project's folder has no GitHub remote named origin. Add one, then check again.",
        command: null,
        checkable: true,
      };
    case "failed":
      return {
        title: "Could not load GitHub issues",
        description: problem.message,
        command: null,
        checkable: true,
      };
  }
}

/** One project's issue list. */
export interface GitHubIssuesList {
  view: GitHubIssuesView | null;
  loading: boolean;
  problem: GitHubIssuesProblem | null;
}

/** One issue's page. */
export interface GitHubIssuePage {
  detail: GitHubIssueDetail | null;
  loading: boolean;
  problem: GitHubIssuesProblem | null;
}

const EMPTY_LIST: GitHubIssuesList = {
  view: null,
  loading: false,
  problem: null,
};

const EMPTY_PAGE: GitHubIssuePage = {
  detail: null,
  loading: false,
  problem: null,
};

/** The key an issue's page is held under. */
export const issueKey = (slug: string, number: number) => `${slug}#${number}`;

const api = () => {
  const surface = window.desktop?.git;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * Request tickets, one per list and one per page.
 *
 * NOTE: The same guard as `stores/pulls.ts`. A focus refresh and a click on
 * "Check again" can overlap, and the slower read must not land last.
 */
const tickets = new Map<string, number>();
const take = (key: string) => {
  const next = (tickets.get(key) ?? 0) + 1;
  tickets.set(key, next);
  return () => tickets.get(key) === next;
};

interface GitHubIssuesState {
  /**
   * Each project's list, by slug.
   *
   * NOTE: Kept per project rather than reset on a switch. Going back to a
   * project draws its last list at once, and the re-read replaces it.
   */
  lists: Record<string, GitHubIssuesList>;
  /** Each opened issue, by `issueKey(slug, number)`. */
  pages: Record<string, GitHubIssuePage>;
  /** Whether `check` is asking `gh` again. */
  checking: boolean;

  /**
   * Read this project's open issues, from main's cache when it has them.
   *
   * Asks for the account and the folder's repo first, so a project that
   * cannot be read says why instead of failing a request.
   */
  open: (slug: string) => Promise<void>;
  /**
   * Read the list again, past main's cache.
   *
   * For window focus and the refresh button (FE-75/D7); nothing calls it on
   * a timer.
   */
  refresh: (slug: string) => Promise<void>;
  /**
   * Ask `gh` again, then re-read this project.
   *
   * Backs "Check again" after somebody installs `gh` or runs `gh auth login`.
   */
  check: (slug: string) => Promise<void>;
  /** Read one issue with its body and comments. */
  openIssue: (slug: string, number: number) => Promise<void>;
}

export const useGitHubIssues = create<GitHubIssuesState>((set, get) => {
  const patchList = (slug: string, patch: Partial<GitHubIssuesList>) =>
    set((state) => ({
      lists: {
        ...state.lists,
        [slug]: { ...(state.lists[slug] ?? EMPTY_LIST), ...patch },
      },
    }));
  const patchPage = (key: string, patch: Partial<GitHubIssuePage>) =>
    set((state) => ({
      pages: {
        ...state.pages,
        [key]: { ...(state.pages[key] ?? EMPTY_PAGE), ...patch },
      },
    }));

  /** The list read, shared by `open` and `refresh`. */
  const read = async (slug: string, refresh: boolean) => {
    const current = take(`list:${slug}`);
    patchList(slug, { loading: true });
    try {
      const [account, repo] = await Promise.all([
        api().account(),
        api().repo(slug),
      ]);
      if (!current()) return;
      const problem = problemOf(account, repo);
      if (problem) {
        // NOTE: The list goes too. Issues read under a login that has since
        // ended would read as current.
        patchList(slug, { view: null, loading: false, problem });
        return;
      }
      const view = await api().issues(slug, refresh);
      if (!current()) return;
      patchList(slug, { view, loading: false, problem: null });
    } catch (error) {
      if (!current()) return;
      // NOTE: A list already on screen stays. A failed re-read says so beside
      // it rather than emptying what somebody is reading.
      patchList(slug, {
        loading: false,
        problem: {
          kind: "failed",
          message: ipcMessage(error, "Could not load GitHub issues."),
        },
      });
    }
  };

  return {
    lists: {},
    pages: {},
    checking: false,

    open: (slug) => read(slug, false),

    refresh: async (slug) => {
      if (get().lists[slug]?.loading) return;
      await read(slug, true);
    },

    check: async (slug) => {
      if (get().checking) return;
      set({ checking: true });
      try {
        await api().check();
        await read(slug, true);
      } catch (error) {
        patchList(slug, {
          problem: {
            kind: "failed",
            message: ipcMessage(error, "Could not run the GitHub CLI."),
          },
        });
      } finally {
        set({ checking: false });
      }
    },

    openIssue: async (slug, number) => {
      const key = issueKey(slug, number);
      const current = take(`page:${key}`);
      patchPage(key, { loading: true });
      try {
        const [account, repo] = await Promise.all([
          api().account(),
          api().repo(slug),
        ]);
        if (!current()) return;
        const problem = problemOf(account, repo);
        if (problem) {
          patchPage(key, { detail: null, loading: false, problem });
          return;
        }
        const detail = await api().issue(slug, number);
        if (!current()) return;
        patchPage(key, { detail, loading: false, problem: null });
      } catch (error) {
        if (!current()) return;
        patchPage(key, {
          loading: false,
          problem: {
            kind: "failed",
            message: ipcMessage(error, "Could not load that issue."),
          },
        });
      }
    },
  };
});

/** A project's list, or an empty one before its first read. */
export const listOf = (state: GitHubIssuesState, slug: string) =>
  state.lists[slug] ?? EMPTY_LIST;

/** An issue's page, or an empty one before its first read. */
export const pageOf = (
  state: GitHubIssuesState,
  slug: string,
  number: number,
) => state.pages[issueKey(slug, number)] ?? EMPTY_PAGE;
