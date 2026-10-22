// Reading a project's pull requests and issues through the GitHub CLI (`gh`).
//
// - GitHub only. The names are host-neutral (`RepoRef`, `PullRequest`) so a
//   second host would not force a renderer rewrite, but there is no provider
//   abstraction: an interface with one implementation is wrong in ways nobody
//   sees until the second arrives. The board already speaks GitHub
//   (`BoardAssignees.users` is a GitHub login).
// - This app holds no GitHub credential and stores nothing about GitHub
//   (FE-73). `gh` owns the login and main runs it. The repo is read from the
//   project's linked folder on every request, and the fork/parent choice lives
//   only in the running session.

/**
 * One repository, already split into owner and name.
 *
 * Every call downstream needs the halves separately; carrying the joined
 * `owner/repo` string would have each caller splitting it again, differently.
 * {@link parseRepoRef} is the one place the string becomes this.
 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** `owner/repo`, for display and for anything that has to say it back. */
export function formatRepoRef(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * GitHub's rule for owner and repo names, mirrored.
 *
 * Strict because the value comes from a folder's `origin` remote, text this
 * app did not write, and ends up in arguments handed to `gh`. Anything with a
 * slash, a dot segment or a scheme in it is not a repo name.
 */
const REPO_REF = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/;

/**
 * Parse `owner/repo` into a {@link RepoRef}, or null.
 *
 * Accepts every shape a GitHub remote takes: a full URL, a `.git` suffix, an
 * `scp`-style remote.
 *
 * NOTE: It does not check the host: `https://gitlab.com/x` parses as
 * `gitlab.com/x`. A caller reading a remote must confirm it points at
 * github.com first.
 */
export function parseRepoRef(raw: string): RepoRef | null {
  let value = raw.trim();
  if (!value) return null;

  // `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`,
  // `ssh://git@github.com/owner/repo`.
  value = value
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^git@/i, "")
    .replace(/^github\.com[:/]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const match = REPO_REF.exec(value);
  if (!match) return null;
  const [, owner, repo] = match;
  // `.` and `..` pass the regex but are path traversal to a URL builder.
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * What the GitHub CLI says about this machine.
 *
 * - `missing`: `gh` is not installed, or not on the PATH main can see.
 * - `logged-out`: `gh` is there, but `gh auth status` has no usable login.
 * - `unreachable`: `gh` is there, but GitHub did not answer (offline, DNS,
 *   timeout). The next step is the network, not `gh auth login`.
 * - `ok`: signed in to github.com as `login`.
 *
 * NOTE: There is no token field, and main never reads the token: `gh` makes
 * every request itself. This object crosses into a web origin, and a token
 * readable by script in the renderer is a leaked token. The renderer only
 * learns that `gh` works and as whom.
 */
export type GitAccount =
  | { kind: "missing" }
  | { kind: "logged-out" }
  | { kind: "unreachable" }
  | { kind: "ok"; login: string; avatarUrl: string | null };

/**
 * Which of the two repos a fork checkout reads pull requests from.
 *
 * `self` is the folder's own `origin`; `parent` is the repo it was forked from.
 */
export type RepoSide = "self" | "parent";

/**
 * The repo a project reads pull requests from, detected from its linked folder.
 *
 * - `no-folder`: the project has no local folder on this machine.
 * - `not-github`: the folder is not a git checkout with a GitHub `origin`.
 * - `detected`: `repo` is the folder's `origin`; `parent` is what GitHub says
 *   it was forked from, or null; `selected` is the side reads go to.
 *
 * Detected, never stored: the folder is the source of truth, and a choice of
 * `parent` lasts as long as the session (`selectRepo`). {@link selectedRepo}
 * gives the one repo reads actually use.
 */
export type RepoState =
  | { kind: "no-folder" }
  | { kind: "not-github" }
  | {
      kind: "detected";
      repo: RepoRef;
      parent: RepoRef | null;
      selected: RepoSide;
    };

/**
 * The repo reads go to, or null when there is none.
 *
 * `parent` falls back to `repo` when there is no parent, so a stale choice
 * never resolves to nothing.
 */
export function selectedRepo(state: RepoState | null): RepoRef | null {
  if (state?.kind !== "detected") return null;
  return state.selected === "parent" && state.parent
    ? state.parent
    : state.repo;
}

/**
 * Which pull requests a read asks for.
 *
 * `merged` is its own value rather than a flavour of `closed`: "what shipped"
 * and "what was thrown away" are opposite outcomes to a person, and GitHub
 * reports them separately too.
 */
export const PULL_STATUSES = ["open", "merged", "closed", "all"] as const;
export type PullStatus = (typeof PULL_STATUSES)[number];

/** Where one pull request stands. */
export type PullState = "open" | "merged" | "closed";

export interface PullAuthor {
  login: string;
  avatarUrl: string | null;
}

/**
 * A pull request, trimmed to what this app draws.
 *
 * `additions` / `deletions` / `changedFiles` are not nullable, which decides
 * how the list is read. REST's `GET /pulls` does not carry them (only a
 * single-PR read does), so a list of 25 would cost 26 requests. One GraphQL
 * query answers the whole list, including these, `reviewRequests` and
 * `viewer`, for one point. See `client.ts`.
 */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PullState;
  author: PullAuthor | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  /** True when the signed-in user is in this PR's requested reviewers. */
  reviewRequested: boolean;
  /** True when the signed-in user opened it. */
  authored: boolean;
  /** `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`, or null. */
  reviewDecision: string | null;
}

/**
 * A repo's pull requests as of one read.
 *
 * Carries `fetchedAt` + `stale` for the same reason `BoardView` does: "there
 * are no pull requests" and "I could not ask GitHub" look identical on
 * screen, and the second must not be drawn as the first.
 */
export interface PullsView {
  repo: RepoRef;
  /** The filter this list answers, so a screen cannot mislabel what it drew. */
  status: PullStatus;
  /** The login the grouping was computed against, so the UI can say whose. */
  viewer: string | null;
  pulls: PullRequest[];
  fetchedAt: string;
  stale: boolean;
}

/** How a file changed, in GitHub's own words. */
export type PullFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PullFile {
  path: string;
  /** The file's previous name on a rename; null otherwise. */
  previousPath: string | null;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  /**
   * The unified diff for this file, or null.
   *
   * NOTE: Null is a real answer, not a failure: GitHub omits `patch` for
   * binary files and for diffs it considers too large. Drawing null as an
   * empty diff would say "nothing changed" about a file that changed a lot.
   */
  patch: string | null;
}

/** Merge strategies GitHub supports; repository settings narrow this list. */
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface PullMergeState {
  /** Null while GitHub is still calculating mergeability. */
  mergeable: boolean | null;
  state: string | null;
  canMerge: boolean;
  methods: MergeMethod[];
}

export interface PullDetail {
  repo: RepoRef;
  pull: PullRequest;
  body: string;
  /** Optional for compatibility with older detail fixtures. */
  merge?: PullMergeState;
  /** The commit the diff is against; the new side of a file is read here. */
  headSha: string;
  /**
   * The commit the diff is from.
   *
   * Needed to expand the unchanged lines a patch leaves out: that loads both
   * sides of the file in full, and the old side exists only at this commit.
   */
  baseSha: string;
  files: PullFile[];
  /** True when the file list stopped at {@link MAX_PULL_FILES}. */
  truncated: boolean;
  fetchedAt: string;
}

/**
 * How many files of one pull request this app reads.
 *
 * A cap, not an estimate. `GET /pulls/{n}/files` pages at 100 and a
 * dependency bump can touch thousands; main should not spend an unbounded
 * number of round trips. Hitting it sets `truncated`, so the screen can say
 * the list is partial.
 */
export const MAX_PULL_FILES = 300;

/** What a review says. `COMMENT` is the one that may carry an empty body. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * One file, whole, at one commit.
 *
 * The whole file, not a range: the diff renderer expands unchanged regions
 * itself once it has both sides in full.
 *
 * A read answers null when the file is binary, too large to be worth
 * reading, or absent on that side (an added file has no old side). None of
 * those is a failure; they mean the diff cannot be expanded, and the renderer
 * keeps the patch it has.
 */
export interface FileText {
  text: string;
}

/**
 * One commit in a pull request.
 *
 * The subject line only: this is menu text, and the full message belongs on
 * GitHub, which the header links to.
 */
export interface PullCommit {
  sha: string;
  /** The seven characters a human reads a commit by. */
  shortSha: string;
  /** The first line of the message. */
  subject: string;
  authorLogin: string | null;
  committedAt: string;
}

/**
 * One commit's own diff: what it changed, against its parent.
 *
 * - Carries `baseSha` and `headSha` like {@link PullDetail}, because the
 *   renderer expands unchanged lines from both sides and must read them at
 *   this commit's parent. Expanding against the pull request's base would
 *   show lines this commit never touched as if it had.
 * - `baseSha` is empty for a root commit, which has no parent. That means
 *   "expansion is not available", not a failure.
 */
export interface CommitDiff {
  sha: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  truncated: boolean;
}

/**
 * Where a CI check stands, in four words rather than GitHub's eleven.
 *
 * GraphQL reports a check as a `status` plus a `conclusion`, two enums with
 * eleven values between them. A reviewer acts on four: passed, failed, still
 * going, or none of those.
 */
export type CheckState = "success" | "failure" | "pending" | "neutral";

export interface PullCheck {
  id: string;
  name: string;
  state: CheckState;
  /** Where to read the log. Null when GitHub reports a check with no page. */
  url: string | null;
}

/**
 * The CI on a pull request's head commit.
 *
 * `state: null` means there are no checks, which is not a failed read: the
 * caller reports a failed read as an error and this as "No CI checks". A
 * repository with no CI is normal and must not be shown a spinner or error.
 */
export interface PullChecks {
  state: CheckState | null;
  checks: PullCheck[];
  /** True when the list stopped at {@link MAX_PULL_CHECKS}. */
  truncated: boolean;
}

export const MAX_PULL_CHECKS = 50;

/**
 * How many timeline entries one read brings back.
 *
 * The last hundred, not the first: on a long-running pull request the
 * interesting end is "what happened since I last looked".
 */
export const MAX_TIMELINE_ITEMS = 100;

/**
 * One thing that happened on a pull request.
 *
 * - Four kinds; the rest are dropped. GitHub's timeline also carries labels,
 *   renames, review requests, assignments and a dozen more, which outnumber
 *   real events on a dependabot pull request. An unrecognised kind is
 *   skipped, never rendered as a blank row.
 * - `commits` is grouped: a run of pushes becomes one `N commits` entry. The
 *   commit menu in the diff header is where single commits are picked.
 */
export type PullTimelineItem =
  | { kind: "opened"; id: string; actor: string | null; at: string }
  | {
      kind: "commits";
      id: string;
      actor: string | null;
      at: string;
      count: number;
    }
  | {
      kind: "review";
      id: string;
      actor: string | null;
      at: string;
      /** The verdict as GitHub states it, or null for a plain review. */
      verdict: string | null;
      body: string;
    }
  | {
      kind: "comment";
      id: string;
      actor: string | null;
      at: string;
      body: string;
    };

/**
 * A pull request's activity and CI, as of one read.
 *
 * Read lazily, when the summary opens, never with the diff. The pull request
 * screen lands on the diff (the `view` search param), so attaching this to
 * `fetchPull` would make every open pay for a timeline most opens never show.
 * Cached per pull request, like a commit's diff.
 */
export interface PullActivity {
  number: number;
  items: PullTimelineItem[];
  /** True when the timeline stopped at {@link MAX_TIMELINE_ITEMS}. */
  truncated: boolean;
  checks: PullChecks;
  fetchedAt: string;
}

/**
 * How many open issues one read brings back.
 *
 * The fifty most recently updated, not the newest (FE-75/D7): what someone
 * scans the issue list for is what is moving, and an issue opened last year
 * and argued over today is.
 */
export const MAX_ISSUES = 50;

export interface IssueLabel {
  name: string;
  /** Six hex digits without the `#`, as GitHub stores it. */
  color: string;
}

/** A GitHub issue, trimmed to what the issue list draws. */
export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  author: PullAuthor | null;
  labels: IssueLabel[];
  assignees: PullAuthor[];
  /** How many comments it has, so a row can say so without reading them. */
  comments: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A repo's open issues as of one read.
 *
 * Carries `fetchedAt` + `stale` for the same reason {@link PullsView} does.
 */
export interface GitHubIssuesView {
  repo: RepoRef;
  issues: GitHubIssue[];
  fetchedAt: string;
  stale: boolean;
}

export interface GitHubIssueComment {
  id: string;
  author: PullAuthor | null;
  body: string;
  createdAt: string;
  url: string;
}

/**
 * One issue with what its page shows: the body and the comments under it.
 *
 * Read-only (FE-75/D6a). The one action on this screen makes a card from the
 * issue, which is the board's write, not GitHub's.
 */
export interface GitHubIssueDetail {
  repo: RepoRef;
  issue: GitHubIssue;
  body: string;
  comments: GitHubIssueComment[];
}

export const gitChannels = {
  account: "git:account",
  check: "git:account:check",
  accountChanged: "git:account:changed",
  repo: "git:repo",
  selectRepo: "git:repo:select",
  pulls: "git:pulls",
  pull: "git:pull",
  commits: "git:pull:commits",
  commitDiff: "git:commit",
  fileText: "git:pull:file",
  review: "git:pull:review",
  merge: "git:pull:merge",
  activity: "git:pull:activity",
  comment: "git:pull:comment",
  issues: "git:issues",
  issue: "git:issue",
} as const;

/**
 * The pull request and issue surface.
 *
 * NOTE: Every read is keyed by `slug` (the project), never by a repo the
 * renderer names. Main resolves the repo from the project's linked folder and
 * the session's `selectRepo` choice on every call. `DesktopFolderApi` follows
 * the same rule for paths: a channel that fetches whatever the renderer names
 * fetches anything.
 */
export interface DesktopGitApi {
  /** What `gh` last reported. Cheap: answers the cached status if any. */
  account: () => Promise<GitAccount>;
  /**
   * Run `gh` again and answer what it says now.
   *
   * The app never logs in for anybody; `gh auth login` is run by the person
   * in a terminal. This is the "I did it, look again" button. It also fires
   * `onAccountChange` when the answer moved.
   */
  check: () => Promise<GitAccount>;
  onAccountChange: (listener: (account: GitAccount) => void) => () => void;
  /** The repo detected from this project's folder, and the session's choice. */
  repo: (slug: string) => Promise<RepoState>;
  /**
   * Read pull requests from the folder's own repo or from its fork parent.
   *
   * For this session only; nothing is written down. Choosing `parent` on a
   * repo with no parent answers `self`. Answers the state, so a caller never
   * has to guess what took effect.
   */
  selectRepo: (slug: string, side: RepoSide) => Promise<RepoState>;
  /**
   * This project's pull requests in one state.
   *
   * The status is sent to GitHub, not applied here: a merged pull request is
   * not in the open list to be filtered out of.
   *
   * @param refresh skip the cached copy. Without it a read inside the cache
   *   window answers from disk, which makes moving between routes free.
   */
  pulls: (
    slug: string,
    status: PullStatus,
    refresh?: boolean,
  ) => Promise<PullsView>;
  pull: (slug: string, number: number) => Promise<PullDetail>;
  /**
   * The commits in one pull request, oldest first.
   *
   * A read of its own, not a field on {@link PullDetail}: nothing needs it
   * until someone opens the commit menu, and the diff already costs two round
   * trips.
   */
  commits: (slug: string, number: number) => Promise<PullCommit[]>;
  /**
   * What one commit changed, against its parent.
   *
   * Keyed by sha rather than by `(number, index)`: a force-push rewrites a
   * pull request's commits, and an index would then name a different change
   * than the one picked.
   */
  commitDiff: (slug: string, sha: string) => Promise<CommitDiff>;
  /**
   * One file's full contents at a commit, or null when it cannot be read.
   *
   * Fetched on demand, never with the diff: a pull request touching forty
   * files would otherwise be eighty blob reads for context nobody asked for.
   */
  fileText: (
    slug: string,
    path: string,
    sha: string,
  ) => Promise<FileText | null>;
  /**
   * Submit a review on a pull request.
   *
   * PR-level only; there are no line comments. Those need a position model of
   * their own (`path` + `line` + `side` + `commit_id`) and a different screen.
   */
  review: (
    slug: string,
    number: number,
    verdict: ReviewVerdict,
    body: string,
  ) => Promise<void>;
  /** Merge the head commit the user reviewed; GitHub rejects a newer head. */
  merge: (
    slug: string,
    number: number,
    method: MergeMethod,
    headSha: string,
  ) => Promise<void>;
  /**
   * A pull request's timeline and CI checks.
   *
   * One request, not three: the timeline, the comments and the check rollup
   * are all fields of the same GraphQL `PullRequest`, and the budget is hourly.
   */
  activity: (slug: string, number: number) => Promise<PullActivity>;
  /**
   * Leave an ordinary comment on a pull request.
   *
   * NOTE: Not `review`. A review carries a verdict that can block a merge;
   * routing "I have a question" through the call that can say "changes
   * requested" is how someone blocks a pull request by accident.
   */
  comment: (slug: string, number: number, body: string) => Promise<void>;
  /**
   * This project's open issues, the {@link MAX_ISSUES} most recently updated.
   *
   * @param refresh skip the cached copy, as for `pulls`.
   */
  issues: (slug: string, refresh?: boolean) => Promise<GitHubIssuesView>;
  issue: (slug: string, number: number) => Promise<GitHubIssueDetail>;
}
