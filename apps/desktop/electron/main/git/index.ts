import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type CommitDiff,
  type FileText,
  formatRepoRef,
  type GitAccount,
  gitChannels,
  MERGE_METHODS,
  type MergeMethod,
  PULL_STATUSES,
  type PullActivity,
  type PullCommit,
  type PullDetail,
  type PullStatus,
  type PullsView,
  parseRepoRef,
  type RepoRef,
  type RepoSide,
  type RepoState,
  type ReviewVerdict,
  selectedRepo,
} from "../../../shared/git";
import { broadcast, handle } from "../ipc";
import { menuBarWorkspaces, projectFolders } from "../workspaces";
import {
  addComment,
  fetchCommitDiff,
  fetchFileText,
  fetchPull,
  fetchPullActivity,
  fetchPullCommits,
  fetchPulls,
  mergePull,
  submitReview,
} from "./client";
import { GitHubError, gh, ghBlocked, ghJson, relocateGh } from "./gh";
import { removeLegacyStore } from "./store";
import { registerWorktree } from "./worktree-ipc";

/** `execFile` as a promise, for `git` itself. */
const run = promisify(execFile);

/**
 * How long a pull-request list stays fresh.
 *
 * A window, not a poll: moving between routes inside it is free. The one
 * timer is the new-PR watcher, which reads the open list and leaves it here
 * for the screen.
 */
const FRESH_MS = 60_000;

/** How long a folder's detected repo is reused by reads other than `repo`. */
const DETECT_MS = 5 * 60_000;

/**
 * Pull-request lists by `owner/repo:status`.
 *
 * In memory only: nothing about GitHub is stored.
 */
const pullsCache = new Map<string, PullsView>();

/** A list's key in {@link pullsCache}. */
function pullsKey(ref: RepoRef, status: PullStatus): string {
  return `${formatRepoRef(ref).toLowerCase()}:${status}`;
}

/** Whether a list was read less than {@link FRESH_MS} ago. */
function fresh(view: PullsView): boolean {
  const at = Date.parse(view.fetchedAt);
  return Number.isFinite(at) && Date.now() - at < FRESH_MS;
}

/** The last account answer; null until `gh` is first asked. */
let account: GitAccount | null = null;

/** Remember `next`, and tell every window when it differs from before. */
function settle(next: GitAccount): GitAccount {
  if (JSON.stringify(next) !== JSON.stringify(account))
    broadcast(gitChannels.accountChanged, next);
  account = next;
  return next;
}

/**
 * Ask `gh` who is signed in.
 *
 * - `gh auth status` decides signed in or not. Its exit code is the answer;
 *   its text is not parsed.
 * - `gh api user` then gives the login and avatar.
 * - A rate limit or a network error does not mean logged out. The last
 *   answer stands, and the error goes to the caller.
 */
async function readAccount(): Promise<GitAccount> {
  try {
    await gh(["auth", "status", "--active", "--hostname", "github.com"], {
      timeoutMs: 15_000,
    }).catch(async (error) => {
      // `--active` arrived in gh 2.40. An older gh refuses the flag.
      if (error instanceof GitHubError && /unknown flag/i.test(error.message))
        return gh(["auth", "status", "--hostname", "github.com"], {
          timeoutMs: 15_000,
        });
      throw error;
    });
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.kind === "missing") return { kind: "missing" };
    if (error.kind === "rate-limit") throw error;
    // Offline: keep a login we already know rather than flip the screen.
    if (error.kind === "network" || error.kind === "timeout")
      return account?.kind === "ok" ? account : { kind: "unreachable" };
    // Any other failure of `gh auth status` is "no usable login".
    return { kind: "logged-out" };
  }
  const user = await ghJson(["api", "user"], { timeoutMs: 15_000 });
  const data =
    user && typeof user === "object" ? (user as Record<string, unknown>) : {};
  const login = typeof data.login === "string" ? data.login : null;
  if (!login) return { kind: "logged-out" };
  return {
    kind: "ok",
    login,
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}

/**
 * The account, asked of `gh` only when none is known yet.
 *
 * @param force Look for `gh` again and ask afresh: the "check again" button.
 */
async function currentAccount(force: boolean): Promise<GitAccount> {
  if (account && !force) return account;
  if (force) relocateGh();
  return settle(await readAccount());
}

/** The signed-in login, for grouping pull requests. Null when unknown. */
async function viewer(): Promise<string | null> {
  const known = await currentAccount(false).catch(() => account);
  return known?.kind === "ok" ? known.login : null;
}

/**
 * Run a `gh` read and keep the account in step with what it learned.
 *
 * An auth or missing failure flips the account, so the screen offers the
 * right next step instead of retrying against a login that is gone.
 */
async function withGh<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHubError) {
      if (error.kind === "missing") settle({ kind: "missing" });
      else if (error.kind === "auth") settle({ kind: "logged-out" });
    }
    throw error;
  }
}

/** A folder's GitHub repo, and the repo it is a fork of. */
interface Detected {
  repo: RepoRef;
  parent: RepoRef | null;
}

/**
 * Each folder's detected repo, by folder path.
 *
 * A `null` value means "looked, not a GitHub checkout".
 */
const detected = new Map<string, { at: number; value: Detected | null }>();

/** The session's fork/parent choice, by project slug. */
const sides = new Map<string, RepoSide>();

/** The folder's `origin` URL; null when there is none to read. */
async function originUrl(folder: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], {
      cwd: folder,
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    // Not a git repo, no `origin`, no `git`, or the folder is gone.
    return null;
  }
}

/** The host of a remote URL in any of git's forms, lower-cased. */
function remoteHost(url: string): string | null {
  const scheme = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url);
  if (scheme) return scheme[1].toLowerCase();
  const scp = /^(?:[^@/:]+@)?([^/:]+):/.exec(url);
  return scp ? scp[1].toLowerCase() : null;
}

/**
 * A repo from `gh`'s JSON: `nameWithOwner`, or `owner.login` and `name`.
 *
 * @returns null when neither is there or the name is not a valid repo.
 */
function refFrom(value: unknown): RepoRef | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.nameWithOwner === "string")
    return parseRepoRef(data.nameWithOwner);
  const owner = (data.owner as Record<string, unknown> | null)?.login;
  return typeof owner === "string" && typeof data.name === "string"
    ? parseRepoRef(`${owner}/${data.name}`)
    : null;
}

/**
 * The GitHub repo a folder belongs to, and its fork parent.
 *
 * NOTE: `origin` is read first and named to `gh` explicitly. A bare
 * `gh repo view` in a fork with an `upstream` remote answers the upstream
 * repo, which would make the parent look like the folder's own repo.
 *
 * - An `origin` on a host that is not github.com may be an SSH alias for
 *   it, so `gh repo view` in the folder gets a say. It resolves aliases
 *   from the SSH config.
 * - {@link parseRepoRef} checks the shape of every name before it reaches
 *   `gh`.
 *
 * @returns `sure: false` when `gh` could not be asked, so the answer is a
 *   guess that must not be cached.
 */
async function detect(
  folder: string,
): Promise<{ value: Detected | null; sure: boolean }> {
  const url = await originUrl(folder);
  if (!url) return { value: null, sure: true };
  const host = remoteHost(url);
  const github =
    host === "github.com" ||
    host === "www.github.com" ||
    host === "ssh.github.com";
  const origin = github ? parseRepoRef(url) : null;
  if (github && !origin) return { value: null, sure: true };

  const args = ["repo", "view"];
  if (origin) args.push(formatRepoRef(origin));
  args.push("--json", "nameWithOwner,parent,url");
  const data = await ghJson(args, { cwd: folder, timeoutMs: 15_000 }).catch(
    () => null,
  );
  // NOTE: A failed `gh` call (offline, rate limit) is a guess, not an answer:
  // the parent is unknown. It must not be cached, or the fork switch stays
  // hidden for the whole cache window.
  if (!data)
    return {
      value: origin ? { repo: origin, parent: null } : null,
      sure: false,
    };
  const viewUrl = (data as Record<string, unknown>).url;
  if (
    !origin &&
    (typeof viewUrl !== "string" || remoteHost(viewUrl) !== "github.com")
  )
    return { value: null, sure: true };
  const repo = refFrom(data) ?? origin;
  if (!repo) return { value: null, sure: true };
  const parent = refFrom((data as Record<string, unknown>).parent);
  return { value: { repo, parent }, sure: true };
}

/**
 * A folder's repo through the cache, reused for {@link DETECT_MS}.
 *
 * @param force Detect again, whatever the cache holds.
 */
async function detectCached(
  folder: string,
  force: boolean,
): Promise<Detected | null> {
  const hit = detected.get(folder);
  if (!force && hit && Date.now() - hit.at < DETECT_MS) return hit.value;
  const { value, sure } = await detect(folder);
  if (sure) detected.set(folder, { at: Date.now(), value });
  return value;
}

/**
 * The project's primary folder, local board or cloud project alike.
 *
 * NOTE: Resolved through {@link projectFolders}, not `authorizedRecord`. A
 * local board files its folders under no credential, so asking for one here
 * would refuse every project in local mode.
 */
async function folderOf(slug: string): Promise<string | null> {
  return (await projectFolders(slug))[0] ?? null;
}

/**
 * What the pull-request screen knows of a project's repo.
 *
 * @param force Detect the folder's repo again.
 */
async function repoState(slug: string, force: boolean): Promise<RepoState> {
  const folder = await folderOf(slug);
  if (!folder) return { kind: "no-folder" };
  const found = await detectCached(folder, force);
  if (!found) return { kind: "not-github" };
  const side = sides.get(slug) ?? "self";
  return {
    kind: "detected",
    repo: found.repo,
    parent: found.parent,
    selected: side === "parent" && found.parent ? "parent" : "self",
  };
}

/**
 * The repo a project's reads go to: its own, or its fork parent when chosen.
 *
 * @throws When the project has no folder or the folder is not a GitHub repo.
 */
async function repoFor(slug: string): Promise<RepoRef> {
  const state = await repoState(slug, false);
  if (state.kind === "no-folder")
    throw new Error("Link a folder to this project to see its pull requests.");
  const ref = selectedRepo(state);
  if (!ref)
    throw new Error("This project's folder is not a GitHub repository.");
  return ref;
}

/**
 * A list read through the cache.
 *
 * NOTE: A failed read answers the last good copy marked `stale`. An empty
 * list would say "no pull requests", which is a different fact from "could
 * not ask GitHub".
 */
async function readPulls(
  ref: RepoRef,
  status: PullStatus,
  refresh: boolean,
): Promise<PullsView> {
  const key = pullsKey(ref, status);
  const cached = pullsCache.get(key);
  if (!refresh && cached && fresh(cached)) return cached;
  try {
    const view = await withGh(async () =>
      fetchPulls(ref, status, await viewer()),
    );
    pullsCache.set(key, view);
    return view;
  } catch (error) {
    if (cached) return { ...cached, stale: true };
    throw error;
  }
}

/**
 * Every project's open pull requests, read fresh, for the new-PR watcher.
 *
 * - A repo another project already read is skipped.
 * - A repo that cannot be read is left out, not reported: a timer has no
 *   screen to show a refusal on.
 * - Nothing runs while a rate limit blocks `gh`, or when `gh` is missing or
 *   signed out.
 */
export async function readLinkedOpenPulls(): Promise<
  { slug: string; view: PullsView }[]
> {
  if (ghBlocked()) return [];
  const projects = await menuBarWorkspaces().catch(() => null);
  if (!projects) return [];
  const known = await currentAccount(false).catch(() => null);
  if (known?.kind !== "ok") return [];
  const read = new Set<string>();
  const out: { slug: string; view: PullsView }[] = [];
  for (const { slug } of projects) {
    if (ghBlocked()) break;
    try {
      const ref = await repoFor(slug);
      const key = formatRepoRef(ref).toLowerCase();
      if (read.has(key)) continue;
      read.add(key);
      const view = await withGh(() => fetchPulls(ref, "open", known.login));
      pullsCache.set(pullsKey(ref, "open"), view);
      out.push({ slug, view });
    } catch {
      // One repo out of reach must not cost the others their notifications.
    }
  }
  return out;
}

/**
 * A non-empty string from the renderer, checked.
 *
 * @throws When it is missing, blank, or longer than `max`.
 */
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("That value is required.");
  if (value.length > max) throw new Error("That value is too long.");
  return value;
}

/**
 * A pull request's number from the renderer, checked.
 *
 * @throws When it is not a positive integer.
 */
function positive(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 1_000_000_000
  )
    throw new Error("That is not a valid number.");
  return value;
}

/**
 * The merges in flight, by `owner/repo/number`.
 *
 * A second click while one runs is refused, not sent to GitHub twice.
 */
const pendingMerges = new Set<string>();

/**
 * A commit, as `gh` will accept it.
 *
 * Hex only. Every sha here comes from the renderer and goes into a `gh api`
 * path, so its shape is checked, not trusted.
 */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The review verdicts the renderer may send. */
const VERDICTS = new Set<ReviewVerdict>([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
]);

/** The repo sides the renderer may pick. */
const SIDES = new Set<RepoSide>(["self", "parent"]);

/** Register the pull-request and worktree IPC handlers. */
export function registerGit(devUrl?: string): void {
  registerWorktree(devUrl);
  // Delete what the app stored about GitHub before `gh` made its requests.
  void removeLegacyStore();

  handle(gitChannels.account, devUrl, async (): Promise<GitAccount> => {
    return currentAccount(false);
  });

  handle(gitChannels.check, devUrl, async (): Promise<GitAccount> => {
    return currentAccount(true);
  });

  // Every read below is keyed by `slug`. The renderer never names a repo:
  // main finds it from the project's folder.
  handle(gitChannels.repo, devUrl, async (args): Promise<RepoState> => {
    if (args.length !== 1) throw new Error("A project is required.");
    const slug = text(args[0], 200);
    return repoState(slug, true);
  });

  handle(gitChannels.selectRepo, devUrl, async (args): Promise<RepoState> => {
    if (args.length !== 2) throw new Error("A project and side are required.");
    const slug = text(args[0], 200);
    const side = args[1] as RepoSide;
    if (!SIDES.has(side)) throw new Error("That is not a repository side.");
    const state = await repoState(slug, false);
    sides.set(
      slug,
      side === "parent" && state.kind === "detected" && state.parent
        ? "parent"
        : "self",
    );
    return repoState(slug, false);
  });

  handle(gitChannels.pulls, devUrl, async (args): Promise<PullsView> => {
    if (args.length !== 3) throw new Error("A project is required.");
    const slug = text(args[0], 200);
    const status = args[1] as PullStatus;
    if (!PULL_STATUSES.includes(status))
      throw new Error("That is not a pull request state.");
    const refresh = args[2] === true;
    const ref = await repoFor(slug);
    return readPulls(ref, status, refresh);
  });

  handle(gitChannels.pull, devUrl, async (args): Promise<PullDetail> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const ref = await repoFor(slug);
    return withGh(async () => fetchPull(ref, number, await viewer()));
  });

  handle(gitChannels.commits, devUrl, async (args): Promise<PullCommit[]> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const ref = await repoFor(slug);
    return withGh(() => fetchPullCommits(ref, number));
  });

  handle(gitChannels.commitDiff, devUrl, async (args): Promise<CommitDiff> => {
    if (args.length !== 2) throw new Error("A commit is required.");
    const slug = text(args[0], 200);
    const sha = text(args[1], 100);
    if (!COMMIT_SHA.test(sha)) throw new Error("That is not a valid commit.");
    const ref = await repoFor(slug);
    return withGh(() => fetchCommitDiff(ref, sha));
  });

  handle(
    gitChannels.fileText,
    devUrl,
    async (args): Promise<FileText | null> => {
      if (args.length !== 3) throw new Error("A file is required.");
      const slug = text(args[0], 200);
      const path = text(args[1], 1000);
      const sha = text(args[2], 100);
      if (!COMMIT_SHA.test(sha)) throw new Error("That is not a valid commit.");
      const ref = await repoFor(slug);
      return withGh(() => fetchFileText(ref, path, sha));
    },
  );

  handle(gitChannels.merge, devUrl, async (args): Promise<void> => {
    if (args.length !== 4) throw new Error("A merge is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const method = args[2] as MergeMethod;
    const sha = text(args[3], 100);
    if (!MERGE_METHODS.includes(method))
      throw new Error("That is not a merge method.");
    if (!/^[0-9a-f]{40,64}$/i.test(sha))
      throw new Error("A full head commit is required.");
    const ref = await repoFor(slug);
    const key = `${formatRepoRef(ref).toLowerCase()}/${number}`;
    if (pendingMerges.has(key))
      throw new Error("A merge is already in progress for this pull request.");
    pendingMerges.add(key);
    try {
      await withGh(() => mergePull(ref, number, method, sha));
    } finally {
      pendingMerges.delete(key);
    }
    // The open and merged lists both changed.
    for (const status of PULL_STATUSES)
      pullsCache.delete(pullsKey(ref, status));
  });

  handle(gitChannels.review, devUrl, async (args): Promise<void> => {
    if (args.length !== 4) throw new Error("A review is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const verdict = args[2] as ReviewVerdict;
    if (!VERDICTS.has(verdict)) throw new Error("That is not a review.");
    const body = typeof args[3] === "string" ? args[3] : "";
    if (body.length > 60_000) throw new Error("That review is too long.");
    const ref = await repoFor(slug);
    await withGh(() => submitReview(ref, number, verdict, body));
  });

  handle(gitChannels.activity, devUrl, async (args): Promise<PullActivity> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const ref = await repoFor(slug);
    return withGh(() => fetchPullActivity(ref, number));
  });

  handle(gitChannels.comment, devUrl, async (args): Promise<void> => {
    if (args.length !== 3) throw new Error("A comment is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const body = typeof args[2] === "string" ? args[2] : "";
    // A body this long is a paste accident, and GitHub would refuse it.
    if (body.length > 60_000) throw new Error("That comment is too long.");
    const ref = await repoFor(slug);
    await withGh(() => addComment(ref, number, body));
  });
}
