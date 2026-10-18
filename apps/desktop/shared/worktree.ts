/**
 * The project's LOCAL repository: its working tree, its index, its history
 * (FE-22).
 *
 * ⚠️ Separate from `git.ts`, which is GitHub. Nothing here touches the network
 * except `sync`, nothing here needs a token, and a project with no GitHub
 * connection at all still has a folder with changes in it.
 *
 * ⚠️ Every call names a PROJECT, never a folder. Main resolves the slug to the
 * primary folder it wrote down itself, so no channel here can be pointed at an
 * arbitrary directory on the machine.
 */

/** What happened to one file, in the working tree's own terms. */
export type WorktreeFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/**
 * How much of a file's change is in the index.
 *
 * ⚠️ `partial` is real, not a rounding: a file staged and then edited again has
 * one change in the index and another beside it. The checkbox shows it as
 * indeterminate, and ticking it stages the rest.
 */
export type StagedState = "none" | "partial" | "full";

export interface WorktreeFile {
  path: string;
  /** Set only on a rename, and then it is the name this file had before. */
  previousPath: string | null;
  status: WorktreeFileStatus;
  staged: StagedState;
  additions: number;
  deletions: number;
  /** True when git calls it binary — there are no lines to count or show. */
  binary: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  /** Everything after the subject line, trimmed. Empty for a one-line message. */
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, as git wrote it. */
  authoredAt: string;
  /**
   * True when no remote branch has this commit yet — it goes out on the next
   * push. Only History (`log`) sets it; absent everywhere else.
   */
  unpushed?: boolean;
}

export interface BranchState {
  /** Null when HEAD is detached. */
  name: string | null;
  /** Null when the branch has no upstream to be ahead of or behind. */
  ahead: number | null;
  behind: number | null;
}

/**
 * What the project's folder turned out to be.
 *
 * ⚠️ Four ways to have nothing, each with its own sentence. "No folder linked",
 * "the folder is gone", "not a git repository" and "git is not installed" need
 * four different fixes, and one generic empty state would send somebody to the
 * wrong one.
 */
export type WorktreeState =
  | { kind: "none" }
  | { kind: "missing"; path: string }
  | { kind: "not-repo"; path: string }
  | { kind: "no-git" }
  | {
      kind: "ready";
      folder: string;
      branch: BranchState;
      files: WorktreeFile[];
      /** The newest commit on HEAD, or null in a repository with none yet. */
      head: CommitSummary | null;
      /** The repository's remotes by name, as `git remote` lists them. */
      remotes: string[];
      /**
       * Commits on HEAD no remote branch has — History's ↑ rows, counted.
       * 0 with no remote: with nowhere to push, nothing is "not pushed".
       */
      unpushed: number;
    };

/**
 * Every changed file as ONE unified patch, as git itself printed it.
 *
 * ⚠️ Full headers, unlike GitHub's per-file hunks. The viewer parses this as
 * is; nothing has to rebuild `diff --git` lines the way the pull request screen
 * does.
 */
export interface WorktreePatch {
  patch: string;
  /** Untracked files left out because there were too many to read. */
  skipped: number;
}

export interface CommitHistory {
  commits: CommitSummary[];
  /** True when there is at least one more page. */
  more: boolean;
}

export interface CommitChange {
  commit: CommitSummary;
  patch: string;
  files: Pick<
    WorktreeFile,
    "path" | "previousPath" | "additions" | "deletions" | "binary"
  >[];
}

/**
 * The branches a project can switch to.
 *
 * ⚠️ `remote` leaves out every remote branch that already has a local branch of
 * the same name: switching to `origin/main` when `main` exists would mean the
 * local one, and listing both invites picking the wrong row.
 */
export interface BranchList {
  /** Null when HEAD is detached. */
  current: string | null;
  /** Local branches, most recently committed first. */
  local: string[];
  /** `origin/name` form, most recently committed first. */
  remote: string[];
}

/** One page of history. */
export const HISTORY_PAGE = 100;

/**
 * Which side of a file to read, when the viewer expands unchanged lines.
 *
 * ⚠️ A revision the RENDERER names is only ever a sha it was given, or the
 * literal `HEAD`. Main checks the shape before it reaches `git show`.
 */
export type FileSide = { kind: "worktree" } | { kind: "rev"; rev: string };

/** How a commit is made: what is staged, or every tracked change. */
export type CommitMode = "staged" | "tracked";

/**
 * One exchange with a remote, from the Changes screen's sync button.
 *
 * ⚠️ `force-push` is `--force-with-lease`, never a bare `--force`: it refuses
 * when the remote moved since the last fetch, so it cannot erase a commit
 * somebody else pushed that this machine has never seen.
 */
export type SyncAction =
  | "fetch"
  | "pull"
  | "pull-rebase"
  | "push"
  | "force-push";

/**
 * Paths for Repository › Files (FE-66): directories end with `/`, the way
 * `@pierre/trees` takes them.
 *
 * ⚠️ `lazy` are directories listed WITHOUT their contents — what git ignores
 * (`node_modules/`, `dist/`) at the top read, and every subdirectory of a
 * directory read with `dir`. The tree asks for one when somebody opens it;
 * walking a `node_modules` up front to draw a sidebar would be a hundred
 * thousand stats nobody looks at.
 */
export interface FileListing {
  /** The repository's folder on this machine, for "Copy Path". */
  root: string;
  paths: string[];
  lazy: string[];
  /** Paths git ignores — drawn greyed, the way an editor does. */
  ignored: string[];
  /** True when the listing hit its cap and stops short. */
  truncated: boolean;
}

/** One file as the Files screen shows it. */
export type FileView =
  | { kind: "text"; text: string; size: number }
  /** An image, as a `data:` URL — drawn rather than called binary. */
  | { kind: "image"; url: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number }
  | { kind: "missing" };

export const worktreeChannels = {
  files: "worktree:files",
  dir: "worktree:dir",
  view: "worktree:view",
  reveal: "worktree:reveal",
  locate: "worktree:locate",
  openDefault: "worktree:open-default",
  status: "worktree:status",
  patch: "worktree:patch",
  fileText: "worktree:file",
  stage: "worktree:stage",
  unstage: "worktree:unstage",
  restore: "worktree:restore",
  commit: "worktree:commit",
  sync: "worktree:sync",
  log: "worktree:log",
  show: "worktree:show",
  branches: "worktree:branches",
  switchBranch: "worktree:switch",
} as const;

/**
 * The local-repository surface.
 *
 * ⚠️ Paths travel as the paths `status` answered, and main re-reads the status
 * before acting on them: a path that is not a current change is refused rather
 * than handed to `git`. That is what keeps `restore` — which deletes untracked
 * files — from being a way to delete anything else.
 */
export interface DesktopWorktreeApi {
  /** The working tree for Repository › Files (FE-66), ignored folders unread. */
  files: (slug: string) => Promise<FileListing>;
  /** One directory's own entries; every subdirectory comes back `lazy`. */
  dir: (slug: string, path: string) => Promise<FileListing>;
  /** One file of the working tree, or why it cannot be shown. */
  view: (slug: string, path: string) => Promise<FileView>;
  /** Show one file of the working tree in Finder / Explorer. */
  reveal: (slug: string, path: string) => Promise<void>;
  /**
   * A path as somebody wrote it — relative to the project's folder, to the
   * repository, absolute, or a bare name — as the repository path of the one
   * file it means. Null when it is not in the repository, or is ambiguous.
   */
  locate: (slug: string, path: string) => Promise<string | null>;
  /**
   * Open a file or folder of the working tree in its default app. Refused for
   * anything that would RUN — an app, a script, an executable.
   */
  openDefault: (slug: string, path: string) => Promise<void>;
  status: (slug: string) => Promise<WorktreeState>;
  patch: (slug: string) => Promise<WorktreePatch>;
  /** One side of one file in full, or null when that side does not exist. */
  fileText: (
    slug: string,
    path: string,
    side: FileSide,
  ) => Promise<string | null>;
  stage: (slug: string, paths: string[]) => Promise<WorktreeState>;
  unstage: (slug: string, paths: string[]) => Promise<WorktreeState>;
  /** Throw a change away. Untracked files are DELETED. */
  restore: (slug: string, paths: string[]) => Promise<WorktreeState>;
  commit: (
    slug: string,
    message: string,
    mode: CommitMode,
  ) => Promise<WorktreeState>;
  /**
   * Fetch, pull or push. `remote` names one of `remotes` for Fetch From and
   * Push To; null means the branch's upstream (or, to push a branch that has
   * none yet, `origin` — and the push then sets it).
   */
  sync: (
    slug: string,
    action: SyncAction,
    remote: string | null,
  ) => Promise<WorktreeState>;
  log: (slug: string, skip: number) => Promise<CommitHistory>;
  show: (slug: string, sha: string) => Promise<CommitChange>;
  /** Null when the project has no repository to have branches in. */
  branches: (slug: string) => Promise<BranchList | null>;
  /**
   * Check out a branch — a local name, or `origin/name` to start tracking one.
   *
   * ⚠️ Never forced. When uncommitted changes would be overwritten git refuses,
   * and that refusal is the answer the screen shows.
   */
  switchBranch: (slug: string, name: string) => Promise<WorktreeState>;
}

/**
 * Line counts per file, read straight off a unified patch.
 *
 * ⚠️ Counted from the patch rather than asked of `--numstat` separately. The
 * numbers a row shows and the lines the viewer draws then come from ONE read,
 * and cannot disagree because the tree changed between two.
 */
/**
 * Files "Open in Default App" will not open (FE-66): opening them runs them.
 * Main also refuses anything with an execute bit; this list is what the menu
 * can know without asking.
 */
export const LAUNCHABLE =
  /\.(app|command|tool|terminal|workflow|action|scpt|applescript|sh|bash|zsh|fish|py|rb|pl|jar|exe|bat|cmd|ps1|msi|pkg|mpkg|dmg|webloc|inetloc|url|desktop)\/?$/i;

export function patchStats(
  patch: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  let current: {
    additions: number;
    deletions: number;
    binary: boolean;
  } | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { additions: 0, deletions: 0, binary: false };
      inHunk = false;
      // The b/ side names the file as it is now; rename/new headers below may
      // say it again, and the last word wins.
      const match = / b\/(.*)$/.exec(line);
      if (match?.[1]) out.set(match[1], current);
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        const name = line.slice(4).replace(/^b\//, "");
        for (const [key, value] of out)
          if (value === current && key !== name) out.delete(key);
        out.set(name, current);
      } else if (line.startsWith("Binary files ")) current.binary = true;
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }
  return out;
}
