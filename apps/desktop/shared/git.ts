/**
 * Reading a project's pull requests through the GitHub CLI (`gh`).
 *
 * ⚠️ GitHub, and it says so. The names here are host-neutral (`RepoRef`,
 * `PullRequest`) so a second host would not force the renderer to be rewritten,
 * but there is no provider abstraction and deliberately so: an interface with
 * exactly one implementation is wrong in some way nobody can see until the
 * second one arrives. The board already speaks GitHub — `BoardAssignees.users`
 * is a GitHub login — so this is the host that matches the data we hold.
 *
 * ⚠️ This app holds NO GitHub credential and stores NOTHING about GitHub (FE-73).
 * `gh` owns the login; main runs it. The repo is read from the project's linked
 * folder every time it is asked for, and the fork/parent choice lives only in
 * the running session.
 */

/**
 * One repository, already split.
 *
 * ⚠️ Two fields rather than the `owner/repo` string a human types. Every call
 * downstream needs the halves separately, and a type that carried the joined
 * form would have each caller splitting it again — differently, eventually.
 * `parseRepoRef` is the one place the string becomes this.
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
 * GitHub's own rule for what an owner and a repo may be called, mirrored.
 *
 * ⚠️ Strict on purpose. The value comes from a folder's `origin` remote — text
 * on disk this app did not write — and ends up in arguments handed to `gh`, so
 * it is validated where it is read rather than trusted. Anything with a slash,
 * a dot segment or a scheme in it is not a repo name and must not become one.
 */
const REPO_REF = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/;

/**
 * `owner/repo` as a `RepoRef`, or null.
 *
 * Accepts every shape a GitHub remote takes — a full URL, a `.git` suffix, an
 * `scp`-style remote.
 *
 * ⚠️ It does not check the HOST: `https://gitlab.com/x` parses as `gitlab.com/x`.
 * A caller reading a remote must confirm it points at github.com first.
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
  // `.` and `..` are legal-ish repo names to a regex and are path traversal to
  // a URL builder. Refuse them here, once.
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * What the GitHub CLI says about this machine.
 *
 * - `missing`: `gh` is not installed (or not on the PATH main can see).
 * - `logged-out`: `gh` is there, but `gh auth status` has no usable login.
 * - `unreachable`: `gh` is there, but GitHub did not answer (offline, DNS,
 *   timeout). The next step is the network, not `gh auth login`.
 * - `ok`: signed in to github.com as `login`.
 *
 * ⚠️ There is no field for the token, and main never reads it: `gh` makes every
 * request itself. This object crosses into a web origin, and a token readable
 * by anything that achieves script execution in the renderer is a token that
 * has leaked. The renderer gets to know THAT `gh` works and AS WHOM.
 */
export type GitAccount =
  | { kind: "missing" }
  | { kind: "logged-out" }
  | { kind: "unreachable" }
  | { kind: "ok"; login: string; avatarUrl: string | null };

/**
 * Which of the two repos a fork-checkout reads pull requests from.
 *
 * `self` is the folder's own `origin`; `parent` is the repo it was forked from.
 */
export type RepoSide = "self" | "parent";

/**
 * The repo a project reads pull requests from, detected from its linked folder.
 *
 * - `no-folder`: the project has no local folder on this machine.
 * - `not-github`: the folder is not a git checkout with a GitHub `origin`.
 * - `detected`: `repo` is the folder's `origin`; `parent` is what GitHub says it
 *   was forked from, or null; `selected` is the side reads go to.
 *
 * ⚠️ Detected, never stored. Nothing about this is written to disk: the folder
 * is the source of truth, and a choice of `parent` lasts as long as the session
 * (`selectRepo`). See `selectedRepo` for the one repo reads actually use.
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
 * ⚠️ `parent` falls back to `repo` when there is no parent, so a stale choice
 * can never resolve to nothing.
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
 * ⚠️ `merged` is its own value rather than a flavour of `closed`, because that
 * is the distinction people actually want: "what shipped" and "what was thrown
 * away" are the same state to git and opposite outcomes to a person. GitHub
 * reports them separately too, so collapsing them here would be this app
 * inventing a coarser answer than the one it was given.
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
 * ⚠️ `additions` / `deletions` / `changedFiles` are NOT nullable here, and that
 * is what decides how the list is read. REST's `GET /pulls` does not carry them
 * — only a single-PR read does — so a list of 25 would be 26 requests to put
 * `+36 −24` on a row. One GraphQL query answers the whole list including these,
 * `reviewRequests` and `viewer`, and costs one point. See `client.ts`.
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
 * A repo's open pull requests as of one read.
 *
 * ⚠️ Carries `fetchedAt` + `stale` for the same reason `BoardView` does: "there
 * are no open pull requests" and "I could not ask GitHub" look identical on
 * screen, and the second one must not be drawn as the first.
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
  /** Set only on a rename, and then it is the name this file had before. */
  previousPath: string | null;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  /**
   * The unified diff for this file, or null.
   *
   * ⚠️ Null is a real answer, not a failure: GitHub omits `patch` for binary
   * files and for diffs it considers too large. A viewer that rendered null as
   * an empty diff would say "nothing changed" about a file that changed a lot,
   * so the screen has to say which of the two it is looking at.
   */
  patch: string | null;
}

/** Merge strategies supported by GitHub; repository settings narrow this list. */
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
  /** The commit the diff is against — what the new side of a file is read at. */
  headSha: string;
  /**
   * The commit the diff is FROM.
   *
   * ⚠️ Needed to expand the unchanged lines a patch leaves out: doing that means
   * loading both sides of the file in full, and the old side only exists at this
   * commit. A viewer holding only `headSha` can show the diff and never open it.
   */
  baseSha: string;
  files: PullFile[];
  /** True when the file list stopped at its cap; see `MAX_PULL_FILES`. */
  truncated: boolean;
  fetchedAt: string;
}

/**
 * How many files of one pull request this app reads.
 *
 * ⚠️ A cap, not an estimate. `GET /pulls/{n}/files` pages at 100 and a
 * dependency bump can touch thousands; the main process is not somewhere to
 * spend an unbounded number of round trips. Hitting it sets `truncated`, so the
 * screen can say the list is partial instead of quietly ending early.
 */
export const MAX_PULL_FILES = 300;

/** What a review says. `COMMENT` is the one that may carry an empty body. */
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * One file, whole, at one commit.
 *
 * ⚠️ The WHOLE file, not a range — which is a deliberate change from the slice
 * this used to fetch. The diff renderer expands unchanged regions itself once it
 * has both sides in full; asking for twenty lines at a time meant this app owned
 * the expansion logic, and it only ever expanded downwards.
 *
 * ⚠️ Null is a real answer: the file may be binary, too large to be worth
 * reading, or absent on that side (a file that was added has no old side). None
 * of those is a failure — they mean "this diff cannot be expanded", and the
 * renderer keeps showing the patch it already has.
 */
export interface FileText {
  text: string;
}

/**
 * One commit in a pull request.
 *
 * ⚠️ The subject line only, not the whole message. This is menu text, and a
 * commit body is paragraphs — the full thing belongs on GitHub, which the
 * header already links to.
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
 * One commit's own diff — what it changed, against its parent.
 *
 * ⚠️ Carries `baseSha` and `headSha` the same way `PullDetail` does, because
 * the renderer expands unchanged lines from BOTH sides and must read them at
 * this commit's parent rather than the pull request's base. Expanding a
 * one-commit view against the pull request's base would show lines that the
 * commit on screen never touched as if it had.
 *
 * ⚠️ `baseSha` is empty for a root commit, which has no parent. That is the
 * same "expansion is not available" answer `PullDetail` gives, not a failure.
 */
export interface CommitDiff {
  sha: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  truncated: boolean;
}

/**
 * Where a CI check stands, in four words rather than GitHub's fourteen.
 *
 * ⚠️ A deliberate narrowing. GraphQL reports a check as a `status` plus a
 * `conclusion`, across two enums with eleven values between them — and a screen
 * that shows a row per file does not need to distinguish `STALE` from
 * `SKIPPED`. What a reviewer acts on is: did it pass, did it fail, is it still
 * going, or is it none of those.
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
 * ⚠️ `state: null` means THERE ARE NO CHECKS, which is not the same as a read
 * that failed — the caller reports the second as an error and this as the
 * sentence "No CI checks". A repository with no CI is a normal repository, and
 * a screen that showed it a spinner or an error would be lying about it.
 */
export interface PullChecks {
  state: CheckState | null;
  checks: PullCheck[];
  /** True when the list stopped at `MAX_PULL_CHECKS`. */
  truncated: boolean;
}

export const MAX_PULL_CHECKS = 50;

/**
 * How many timeline entries one read brings back.
 *
 * ⚠️ The LAST hundred, not the first. A long-running pull request's interesting
 * end is the recent one — "what happened since I last looked" — and paging
 * forwards from the day it opened would spend requests to arrive there.
 */
export const MAX_TIMELINE_ITEMS = 100;

/**
 * One thing that happened on a pull request.
 *
 * ⚠️ FOUR kinds, and the rest are dropped rather than drawn. GitHub's timeline
 * also carries labelled/unlabelled, renamed, review-requested, assigned,
 * milestoned and a dozen more; on a dependabot pull request those outnumber the
 * real events several to one. These four are what somebody reads a pull request
 * to find out. An unrecognised kind is skipped — never rendered as a blank row.
 *
 * ⚠️ `commits` is GROUPED: a run of pushes becomes one `N commits` entry rather
 * than N rows. The commit menu in the diff header is where individual commits
 * are chosen; repeating them here would make the timeline mostly commits.
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
 * ⚠️ Read LAZILY — when the summary is opened, never with the diff. The pull
 * request screen lands on the diff (see the `view` search param), so attaching
 * this to `fetchPull` would make every open pay for a timeline most opens never
 * show. Cached per pull request, the same way a commit's diff is.
 */
export interface PullActivity {
  number: number;
  items: PullTimelineItem[];
  /** True when the timeline stopped at `MAX_TIMELINE_ITEMS`. */
  truncated: boolean;
  checks: PullChecks;
  fetchedAt: string;
}

/**
 * How many open issues one read brings back (FE-75/D7).
 *
 * ⚠️ The most recently UPDATED fifty, not the newest. The issue list puts these
 * under the board's own cards, and what somebody scans that group for is
 * "what is moving", which an issue opened last year and argued over today is.
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
 * ⚠️ Carries `fetchedAt` + `stale` for the same reason `PullsView` does.
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
 * ⚠️ Read-only (FE-75/D6a). Nothing on this screen writes to GitHub; the one
 * action it carries out is making a CARD from the issue, and that is the
 * board's write, not GitHub's.
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
 * The pull-request surface.
 *
 * ⚠️ Every read is keyed by `slug` — the project — and never by a repo the
 * renderer names. Main resolves the repo from the project's linked folder (and
 * the session's `selectRepo` choice) on every call. This is the same rule
 * `DesktopFolderApi` states for paths, for the same reason: a channel that
 * fetches whatever the renderer names is a channel that fetches anything.
 */
export interface DesktopGitApi {
  /** What `gh` last reported. Cheap: answers the cached status when it has one. */
  account: () => Promise<GitAccount>;
  /**
   * Run `gh` again and answer what it says now.
   *
   * ⚠️ The app never logs in for anybody — `gh auth login` is run by the person
   * in a terminal. This is the "I did it, look again" button, and it also fires
   * `onAccountChange` when the answer moved.
   */
  check: () => Promise<GitAccount>;
  onAccountChange: (listener: (account: GitAccount) => void) => () => void;
  /** The repo detected from this project's folder, with the session's choice. */
  repo: (slug: string) => Promise<RepoState>;
  /**
   * Read pull requests from the folder's own repo or from its fork parent.
   *
   * ⚠️ For this session only — nothing is written down. Choosing `parent` on a
   * repo with no parent answers `self`. Answers the state, so a caller never
   * has to guess what took effect.
   */
  selectRepo: (slug: string, side: RepoSide) => Promise<RepoState>;
  /**
   * This project's open pull requests.
   *
   * `refresh: true` skips the cached copy. Without it a read inside the cache
   * window answers from disk, which is what makes moving between routes free.
   */
  /**
   * This project's pull requests in one state.
   *
   * ⚠️ The status is sent to GITHUB, not applied here. A closed pull request is
   * not in the open list to be filtered out of — asking for the wrong set and
   * narrowing it locally would show an empty screen for "merged" on a repo full
   * of merged work.
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
   * ⚠️ A read of its own, not a field on `PullDetail`. Nothing needs it until
   * somebody opens the commit menu, and a pull request's diff is already two
   * round trips before this one would add a third to every open.
   */
  commits: (slug: string, number: number) => Promise<PullCommit[]>;
  /**
   * What ONE commit changed, against its parent.
   *
   * ⚠️ Keyed by sha rather than by `(number, index)`: a force-push rewrites a
   * pull request's commits, and an index would then quietly name a different
   * change than the one that was picked.
   */
  commitDiff: (slug: string, sha: string) => Promise<CommitDiff>;
  /**
   * One file's full contents at a commit, or null when it cannot be read.
   *
   * ⚠️ Fetched on demand and never with the diff. A pull request touching forty
   * files would otherwise be eighty blob reads for context nobody asked to see.
   */
  fileText: (
    slug: string,
    path: string,
    sha: string,
  ) => Promise<FileText | null>;
  /**
   * Submit a review on a pull request.
   *
   * ⚠️ PR-level only — there is no line comment here. Those need a position
   * model of their own (`path` + `line` + `side` + `commit_id`) and a different
   * screen; naming them in this signature would promise a feature this does not
   * have.
   */
  review: (
    slug: string,
    number: number,
    verdict: ReviewVerdict,
    body: string,
  ) => Promise<void>;
  /** Merge only the head commit the user reviewed; GitHub rejects a changed head. */
  merge: (
    slug: string,
    number: number,
    method: MergeMethod,
    headSha: string,
  ) => Promise<void>;
  /**
   * A pull request's timeline and CI checks.
   *
   * ⚠️ One request, not three. The timeline, the comments and the check rollup
   * are all fields of the same GraphQL `PullRequest`, so this reads them
   * together rather than making a screen wait on three round trips against an
   * hourly budget.
   */
  activity: (slug: string, number: number) => Promise<PullActivity>;
  /**
   * Leave an ordinary comment on a pull request.
   *
   * ⚠️ NOT `review`. GitHub separates an issue comment from a pull request
   * review, and so does this: a review carries a verdict that can block a
   * merge. Routing "I have a question" through the same call that can say
   * "changes requested" is how somebody blocks a pull request by accident.
   */
  comment: (slug: string, number: number, body: string) => Promise<void>;
  /**
   * This project's open issues, the `MAX_ISSUES` most recently updated.
   *
   * `refresh: true` skips the cached copy, as it does for `pulls`.
   */
  issues: (slug: string, refresh?: boolean) => Promise<GitHubIssuesView>;
  issue: (slug: string, number: number) => Promise<GitHubIssueDetail>;
}
