// The project's local repository: its working tree, its index, its history.
//
// Separate from `git.ts`, which is GitHub. Nothing here touches the network
// except `sync`, nothing needs a token, and a project with no GitHub
// connection still has a folder with changes in it.
//
// NOTE: Every call names a project, never a folder. Main resolves the slug to
// a folder it wrote down itself, so no channel here can be pointed at an
// arbitrary directory on the machine.

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
 * `partial` is real, not a rounding: a file staged and then edited again has
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
  /** True when git calls it binary: there are no lines to count or show. */
  binary: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  /** Everything after the subject line, trimmed. Empty for a one-liner. */
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, as git wrote it. */
  authoredAt: string;
  /**
   * True when no remote branch has this commit yet, so it goes out on the
   * next push. Only History (`log`) sets it; absent everywhere else.
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
 * Four ways to have nothing, each with its own sentence. "No folder linked",
 * "the folder is gone", "not a git repository" and "git is not installed"
 * need four different fixes; one generic empty state would send somebody to
 * the wrong one.
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
       * Commits on HEAD no remote branch has: History's ↑ rows, counted.
       * 0 with no remote: with nowhere to push, nothing is "not pushed".
       */
      unpushed: number;
    };

/**
 * Every changed file as one unified patch, as git printed it.
 *
 * Full headers, unlike GitHub's per-file hunks. The viewer parses this as is;
 * nothing has to rebuild `diff --git` lines the way the pull request screen
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
 * `remote` leaves out every remote branch that already has a local branch of
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
 * NOTE: A revision the renderer names is only ever a sha it was given, or the
 * literal `HEAD`. Main checks the shape before it reaches `git show`.
 */
export type FileSide = { kind: "worktree" } | { kind: "rev"; rev: string };

/** How a commit is made: what is staged, or every tracked change. */
export type CommitMode = "staged" | "tracked";

/**
 * One exchange with a remote, from the Changes screen's sync button.
 *
 * NOTE: `force-push` is `--force-with-lease`, never a bare `--force`. It
 * refuses when the remote moved since the last fetch, so it cannot erase a
 * commit somebody else pushed that this machine has never seen.
 */
export type SyncAction =
  | "fetch"
  | "pull"
  | "pull-rebase"
  | "push"
  | "force-push";

/**
 * Paths for Repository › Files. Directories end with `/`, the way
 * `@pierre/trees` takes them.
 *
 * `lazy` are directories listed without their contents: what git ignores
 * (`node_modules/`, `dist/`) at the top read, and every subdirectory of a
 * directory read with `dir`. The tree asks for one when somebody opens it.
 * Walking a `node_modules` up front to draw a sidebar would be a hundred
 * thousand stats nobody looks at.
 */
export interface FileListing {
  /** The repository's folder on this machine, for "Copy Path". */
  root: string;
  paths: string[];
  lazy: string[];
  /** Paths git ignores, drawn greyed the way an editor does. */
  ignored: string[];
  /** True when the listing hit its cap and stops short. */
  truncated: boolean;
}

/** One file as the Files screen shows it. */
export type FileView =
  | { kind: "text"; text: string; size: number }
  /** An image, as a `data:` URL, drawn rather than called binary. */
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
  repoTrust: "worktree:repo-trust",
  askAgain: "worktree:ask-again",
  restrict: "worktree:restrict",
} as const;

// ── Automatic reads the git gate held back (FE-77/D6, FE-102) ────────────────

/** Why an automatic read did not happen: the user said no, or no check ran. */
export type ReadsRefusal = "refused" | "unchecked";

export const READS_REFUSED_MESSAGE =
  "Lanework did not read this repository. Its git settings run programs of their own, and you chose not to let them run.";
export const READS_UNCHECKED_MESSAGE =
  "Lanework could not check this repository’s git settings, so it did not read it.";

/**
 * What a read channel answers in place of its value when the gate held it
 * back.
 *
 * NOTE: An answer, not a throw: Electron logs every throw out of a handler,
 * and this one is expected. The preload turns it back into an error with the
 * message above, so every screen shows it as it shows any failed read.
 */
export interface HeldRead {
  heldRead: ReadsRefusal;
}

export function isHeldRead(value: unknown): value is HeldRead {
  if (!value || typeof value !== "object") return false;
  const reason = (value as { heldRead?: unknown }).heldRead;
  return reason === "refused" || reason === "unchecked";
}

/** The refusal a read's error message stands for, or null for any other. */
export function refusalOf(message: string | null): ReadsRefusal | null {
  if (message === READS_REFUSED_MESSAGE) return "refused";
  if (message === READS_UNCHECKED_MESSAGE) return "unchecked";
  return null;
}

/**
 * Where the repository's git settings stand (FE-102).
 *
 * - `safe`: nothing in them runs a program.
 * - `allowed` / `refused`: the user's answer to what they name now.
 * - `unasked`: they name programs nobody has answered for yet.
 * - `unchecked`: the check failed.
 * - `none`: no repository to check.
 */
export interface RepoTrust {
  state: "safe" | "allowed" | "refused" | "unasked" | "unchecked" | "none";
  /** What they name, one line each as the prompt lists them. */
  findings: string[];
}

/**
 * The local-repository surface.
 *
 * NOTE: Paths travel as the paths `status` answered, and main re-reads the
 * status before acting on them: a path that is not a current change is
 * refused rather than handed to `git`. That keeps `restore`, which deletes
 * untracked files, from being a way to delete anything else.
 */
export interface DesktopWorktreeApi {
  /**
   * The working tree for Repository › Files, ignored folders unread.
   *
   * NOTE: `folder` on the Files channels is the index of one of the project's
   * linked folders, never a path; the primary is 0 and the default
   * (FE-71/D3). Main looks the folder up in what this machine wrote down.
   */
  files: (slug: string, folder?: number) => Promise<FileListing>;
  /** One directory's own entries; every subdirectory comes back `lazy`. */
  dir: (slug: string, path: string, folder?: number) => Promise<FileListing>;
  /** One file of the working tree, or why it cannot be shown. */
  view: (slug: string, path: string, folder?: number) => Promise<FileView>;
  /** Show one file of the working tree in Finder / Explorer. */
  reveal: (slug: string, path: string, folder?: number) => Promise<void>;
  /**
   * A path as somebody wrote it, as the repository path of the one file it
   * means.
   *
   * The input may be relative to the project's folder or to the repository,
   * absolute, or a bare name.
   *
   * @returns null when it is not in the repository, or is ambiguous.
   */
  locate: (slug: string, path: string) => Promise<string | null>;
  /**
   * Open a file or folder of the working tree in its default app.
   *
   * Refused for anything that would run: an app, a script, an executable.
   */
  openDefault: (slug: string, path: string, folder?: number) => Promise<void>;
  status: (slug: string, folder?: number) => Promise<WorktreeState>;
  patch: (slug: string) => Promise<WorktreePatch>;
  /** One side of one file in full, or null when that side does not exist. */
  fileText: (
    slug: string,
    path: string,
    side: FileSide,
  ) => Promise<string | null>;
  stage: (slug: string, paths: string[]) => Promise<WorktreeState>;
  unstage: (slug: string, paths: string[]) => Promise<WorktreeState>;
  /** Throw a change away. NOTE: Untracked files are deleted. */
  restore: (slug: string, paths: string[]) => Promise<WorktreeState>;
  commit: (
    slug: string,
    message: string,
    mode: CommitMode,
  ) => Promise<WorktreeState>;
  /**
   * Fetch, pull or push.
   *
   * @param remote One of `remotes`, for Fetch From and Push To. null means
   *   the branch's upstream, or `origin` to push a branch that has none yet
   *   (the push then sets it).
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
   * Check out a branch: a local name, or `origin/name` to start tracking one.
   *
   * Never forced. When uncommitted changes would be overwritten git refuses,
   * and that refusal is the answer the screen shows.
   */
  switchBranch: (slug: string, name: string) => Promise<WorktreeState>;
  /** Where the repository's git settings stand; never asks (FE-102). */
  repoTrust: (slug: string, folder?: number) => Promise<RepoTrust>;
  /**
   * Forget the answer and ask again now, in the native prompt (FE-102).
   *
   * Answers where things stand after the user answered.
   */
  askAgain: (slug: string, folder?: number) => Promise<RepoTrust>;
  /** Answer "Don't run" without a prompt: Settings' Stop running. */
  restrict: (slug: string, folder?: number) => Promise<RepoTrust>;
}

/**
 * Files "Open in Default App" will not open, because opening them runs them.
 *
 * Main also refuses anything with an execute bit; this list is what the menu
 * can know without asking.
 */
export const LAUNCHABLE =
  /\.(app|command|tool|terminal|workflow|action|scpt|applescript|sh|bash|zsh|fish|py|rb|pl|jar|exe|bat|cmd|ps1|msi|pkg|mpkg|dmg|webloc|inetloc|url|desktop)\/?$/i;

/**
 * The extensions "Open in Default App" hands to the system (FE-77, D8).
 *
 * An allowlist, not a denylist: a denylist misses whatever it did not think
 * of (`.fileloc`, `.vbs`, `.lnk`, the next one). These are documents and
 * media whose default app shows them. No archive (opening one unpacks it),
 * no HTML (a browser runs its scripts). Anything else is revealed in Finder.
 */
const DOCUMENT_TYPES = new Set([
  "txt",
  "md",
  "markdown",
  "rtf",
  "pdf",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "heic",
  "ico",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "avi",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "pages",
  "numbers",
  "key",
  "epub",
]);

/**
 * Whether "Open in Default App" may open `path` in its default app.
 *
 * By the last extension of the last segment, case-insensitive. A name with
 * none (`Makefile`, `.env`) is not a document: it is revealed instead.
 * Main asks this of the resolved path, so a link named `a.pdf` that points at
 * `a.command` is judged as `a.command`.
 */
export function opensInDefaultApp(path: string): boolean {
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOCUMENT_TYPES.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Line counts per file, read straight off a unified patch.
 *
 * Counted from the patch rather than asked of `--numstat` separately, so the
 * numbers a row shows and the lines the viewer draws come from one read and
 * cannot disagree because the tree changed between two.
 */
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
      // The b/ side names the file as it is now. Rename and new-file headers
      // below may say it again, and the last word wins.
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
