/**
 * Connecting a project to a git host, and reading its pull requests.
 *
 * ⚠️ GitHub, and it says so. The names here are host-neutral (`RepoRef`,
 * `PullRequest`) so a second host would not force the renderer to be rewritten,
 * but there is no provider abstraction and deliberately so: an interface with
 * exactly one implementation is wrong in some way nobody can see until the
 * second one arrives. The board already speaks GitHub — `BoardAssignees.users`
 * is a GitHub login — so this is the host that matches the data we hold.
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
 * ⚠️ Strict on purpose. This is the ONE value that crosses from the renderer
 * into a URL the main process fetches, so it is validated where it arrives
 * rather than trusted — see `DesktopGitApi`. Anything with a slash, a dot
 * segment or a scheme in it is not a repo name and must not become a path.
 */
const REPO_REF = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/;

/**
 * `owner/repo` as a `RepoRef`, or null.
 *
 * Accepts what a person is likely to paste — a full GitHub URL, a `.git` suffix,
 * an `scp`-style remote — because the alternative is a user who can see their
 * repo on screen being told the name is invalid.
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
 * Who this machine is connected to GitHub as.
 *
 * ⚠️ There is no field for the token, for the same reason `RedactedSession` has
 * none: this object crosses into a web origin, and a token readable by anything
 * that achieves script execution in the renderer is a token that has leaked.
 * The renderer gets to know THAT it is connected and AS WHOM, never the secret.
 */
export type GitAccount =
  | { kind: "none" }
  | {
      kind: "connected";
      login: string;
      name: string | null;
      avatarUrl: string | null;
    }
  /**
   * We hold a token GitHub no longer accepts — expired, revoked, or the app's
   * access was removed. Distinct from `none` because there is something on disk
   * to clean up, and because "reconnect" and "connect" are different sentences.
   */
  | { kind: "expired"; login: string | null };

/**
 * Whether a project has a repo, and what to offer when it does not.
 *
 * ⚠️ `suggestion` is read from the linked folder's `origin` remote and is an
 * OFFER, never a link. A project that silently attached itself to whatever
 * remote a folder happened to have is one that will eventually show somebody
 * another team's pull requests.
 */
export type RepoState =
  | { kind: "none"; suggestion: RepoRef | null }
  | { kind: "linked"; repo: RepoRef };

/**
 * One repository the connected account can reach, for the picker.
 *
 * ⚠️ Deliberately thin. This list exists to be SEARCHED and clicked, so it
 * carries what a person picks by — the name, whether it is private, when it
 * last moved — and nothing that would make it worth caching or keeping in step
 * with anything.
 */
export interface RepoOption {
  owner: string;
  repo: string;
  /** `owner/repo`, precomputed because every row and every filter wants it. */
  fullName: string;
  private: boolean;
  /** Last push, so the list can lead with what somebody is actually working on. */
  pushedAt: string | null;
}

/**
 * What the account can see, and whether that is all of it.
 *
 * ⚠️ `capped` is reported rather than swallowed, the same rule
 * `LocalFolderSummary` follows. This list stops at `MAX_REPO_OPTIONS`, and a
 * picker that silently ended early would make somebody conclude their repo is
 * not there — when it is, just past the cut.
 */
export interface RepoOptions {
  repos: RepoOption[];
  capped: boolean;
}

/**
 * How many repositories the picker loads.
 *
 * ⚠️ A cap, not a guess at how many exist. These arrive 100 per request, and an
 * account in a large organization can reach thousands; three round trips is
 * what a picker is worth. Typing the name still works past the cap.
 */
export const MAX_REPO_OPTIONS = 300;

/**
 * One place this GitHub App is installed, as the account sees it.
 *
 * ⚠️ `id` is what travels back to main to open a configuration page, never a
 * URL. A channel that opened a URL the renderer named would open anything; main
 * builds the address itself from an id it has just verified belongs to this
 * account — the same rule the folder chooser follows for paths.
 */
export interface GitInstallation {
  id: number;
  /** The user or organisation the app is installed on. */
  account: string;
}

/**
 * Where this app's access comes from, so the screen can offer to widen it.
 *
 * ⚠️ There is deliberately NO "can this be configured" flag. There was one, and
 * it hid the button in the exact case that needed it: a classic OAuth App's
 * token is refused by `GET /user/installations`, so "we could not list
 * installations" was being read as "there is nothing to configure" — when the
 * real answer for that app is a different GitHub page, not no page. An empty
 * list here means "ask GitHub a different way", never "give up".
 */
export interface GitAppAccess {
  installations: GitInstallation[];
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

export interface PullDetail {
  repo: RepoRef;
  pull: PullRequest;
  body: string;
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

export const gitChannels = {
  account: "git:account",
  connect: "git:connect",
  connectProgress: "git:connect:progress",
  connectCancel: "git:connect:cancel",
  disconnect: "git:disconnect",
  accountChanged: "git:account:changed",
  repo: "git:repo",
  repoOptions: "git:repo:options",
  appAccess: "git:app:access",
  openAppConfig: "git:app:configure",
  linkRepo: "git:repo:link",
  unlinkRepo: "git:repo:unlink",
  pulls: "git:pulls",
  pull: "git:pull",
  fileText: "git:pull:file",
  review: "git:pull:review",
} as const;

/**
 * What a device-flow connection reports while a human is off approving it.
 *
 * ⚠️ The same shape `SignInProgress` uses for the control plane's device mode,
 * because it is the same flow: a code to read out and a URL to open. Stated
 * again here rather than imported so the two can diverge without one of them
 * silently changing the other's screen.
 */
export interface GitConnectProgress {
  userCode: string;
  verificationUri: string;
  /** Poll interval GitHub asked for, in seconds. Honour it or it answers 429. */
  interval: number;
  expiresIn: number;
}

/**
 * The pull-request surface.
 *
 * ⚠️ Every read is keyed by `slug` — the project — and never by a repo the
 * renderer names. The one call that takes `owner/repo` is `linkRepo`, where a
 * human just typed it; it is validated there and written down, and every read
 * afterwards resolves the repo from the slug in main. This is the same rule
 * `DesktopFolderApi` states for paths, for the same reason: a channel that
 * fetches whatever the renderer names is a channel that fetches anything.
 */
export interface DesktopGitApi {
  /** Who we are connected as. Answers `{ kind: "none" }` when nobody. */
  account: () => Promise<GitAccount>;
  /**
   * Start the GitHub device flow and resolve when it finishes.
   *
   * ⚠️ Resolves on the ACCOUNT, not on the token. The code a human has to type
   * arrives separately on `onConnectProgress`, because it exists before this
   * promise settles and the screen has to show it for minutes.
   */
  connect: () => Promise<GitAccount>;
  cancelConnect: () => Promise<void>;
  /** Forget the token on this machine. Repo links survive; they are not secret. */
  disconnect: () => Promise<GitAccount>;
  onConnectProgress: (
    listener: (progress: GitConnectProgress) => void,
  ) => () => void;
  onAccountChange: (listener: (account: GitAccount) => void) => () => void;
  repo: (slug: string) => Promise<RepoState>;
  /**
   * Every repository this connection can reach, newest push first.
   *
   * ⚠️ Not keyed by project, unlike everything else here: it is a property of
   * the ACCOUNT, and the screen that asks for it is the one deciding which
   * project becomes which repo. Loaded on demand — nothing reads this until a
   * person opens the picker.
   */
  repoOptions: () => Promise<RepoOptions>;
  /** Where this app is installed, so the screen can offer to widen its access. */
  appAccess: () => Promise<GitAppAccess>;
  /**
   * Open GitHub's own page for choosing which repositories this app may see.
   *
   * ⚠️ Takes an installation ID or null, NOT a URL. Main resolves it against the
   * installations this account actually has and builds the address itself;
   * `null` means "the page for adding a new one".
   *
   * ⚠️ Opens the OS browser rather than a window inside this app. The person is
   * already signed in there, and a GitHub session living inside an Electron
   * window is a credential this app would then be holding on their behalf.
   */
  openAppConfig: (installationId: number | null) => Promise<void>;
  /**
   * Point a project at a repo. ONE repo per project.
   *
   * ⚠️ Takes the raw string a human typed, not a `RepoRef`: parsing it in main
   * is what makes main the only place that decides what a repo name may be.
   * Answers the state, so a caller never has to guess what was stored.
   */
  linkRepo: (slug: string, raw: string) => Promise<RepoState>;
  unlinkRepo: (slug: string) => Promise<RepoState>;
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
}
