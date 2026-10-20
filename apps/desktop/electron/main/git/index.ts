import { shell } from "electron";
import {
  type CommitDiff,
  type FileText,
  formatRepoRef,
  type GitAccount,
  type GitAppAccess,
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
  type RepoOptions,
  type RepoRef,
  type RepoState,
  type ReviewVerdict,
} from "../../../shared/git";
import type { MachineRecord } from "../auth/store";
import { broadcast, handle } from "../ipc";
import { authorizedRecord } from "../workspaces";
import { readFolders } from "../workspaces/store";
import {
  addComment,
  fetchCommitDiff,
  fetchFileText,
  fetchInstallations,
  fetchPull,
  fetchPullActivity,
  fetchPullCommits,
  fetchPulls,
  fetchRepoOptions,
  fetchViewer,
  GitHubError,
  mergePull,
  submitReview,
} from "./client";
import {
  clientId,
  DeviceFlowError,
  pollForToken,
  requestDeviceCode,
} from "./device-flow";
import { suggestRepo } from "./remote";
import {
  clearToken,
  type GitTokenRecord,
  readPullsCache,
  readRepo,
  readRepos,
  readToken,
  writePullsCache,
  writeRepo,
  writeToken,
} from "./store";
import { registerWorktree } from "./worktree-ipc";

/**
 * How long a pull-request read stays fresh.
 *
 * ⚠️ A window, not a poll. The screen never fetches on a timer: moving
 * between routes inside the window is free, and everything else — opening the
 * screen, refocusing the window, pressing refresh — is a read somebody asked
 * for. The one timer is the new-pull-request watcher (FE-70), which reads only
 * the open list, only while its notification is on, and leaves what it read in
 * the cache for this screen.
 */
const FRESH_MS = 60_000;

function fresh(view: PullsView): boolean {
  const at = Date.parse(view.fetchedAt);
  return Number.isFinite(at) && Date.now() - at < FRESH_MS;
}

function account(token: GitTokenRecord | null): GitAccount {
  if (!token) return { kind: "none" };
  if (token.expiresAt !== null && token.expiresAt <= Date.now())
    return { kind: "expired", login: token.login };
  return {
    kind: "connected",
    login: token.login,
    name: token.name,
    avatarUrl: token.avatarUrl,
  };
}

function announce(value: GitAccount): GitAccount {
  broadcast(gitChannels.accountChanged, value);
  return value;
}

/**
 * The token to use, or a refusal the screen can act on.
 *
 * ⚠️ Refuses an EXPIRED token rather than sending it. GitHub would answer 401
 * and the app would say the same thing one round trip later; refusing here
 * keeps a dead credential from being the reason a rate limit is spent.
 */
async function usableToken(record: MachineRecord): Promise<GitTokenRecord> {
  const token = await readToken(record);
  if (!token) throw new Error("Connect GitHub to see pull requests.");
  if (token.expiresAt !== null && token.expiresAt <= Date.now())
    throw new Error(
      "The GitHub connection expired. Connect again to continue.",
    );
  return token;
}

/**
 * Run a GitHub call, and remember it if the credential turns out to be dead.
 *
 * ⚠️ A 401 is written down, not just reported. Without this the app would ask
 * again on the next screen, get the same 401, and never offer to reconnect —
 * the token would be broken and the UI would keep calling it connected.
 */
async function withToken<T>(
  record: MachineRecord,
  run: (token: GitTokenRecord) => Promise<T>,
): Promise<T> {
  const token = await usableToken(record);
  try {
    return await run(token);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      // `expiresAt: now` IS the fact: GitHub stopped accepting it at this
      // moment. Keeping the row (rather than deleting it) is what lets the
      // screen say "reconnect as @login" instead of "connect".
      await writeToken(record, { ...token, expiresAt: Date.now() }).catch(
        () => {},
      );
      announce({ kind: "expired", login: token.login });
    }
    throw error;
  }
}

async function repoState(
  record: MachineRecord,
  slug: string,
): Promise<RepoState> {
  const linked = await readRepo(record, slug);
  if (linked) return { kind: "linked", repo: linked };
  const primary = (await readFolders(record))[slug]?.[0] ?? null;
  return { kind: "none", suggestion: await suggestRepo(primary) };
}

async function linkedRepo(
  record: MachineRecord,
  slug: string,
): Promise<RepoRef> {
  const ref = await readRepo(record, slug);
  if (!ref) throw new Error("No repository is connected to this project.");
  return ref;
}

/**
 * Every linked project's open pull requests, read fresh, for the watcher
 * (FE-70). A project linked to a repo another one already read is skipped; a
 * repo that cannot be read is left out, not reported.
 *
 * ⚠️ Answers nothing when signed out or GitHub is not connected, rather than
 * throwing: a timer has no screen to show a refusal on.
 */
export async function readLinkedOpenPulls(): Promise<
  { slug: string; view: PullsView }[]
> {
  const record = await authorizedRecord().catch(() => null);
  if (!record) return [];
  const token = await usableToken(record).catch(() => null);
  if (!token) return [];
  const read = new Set<string>();
  const out: { slug: string; view: PullsView }[] = [];
  for (const [slug, ref] of Object.entries(await readRepos(record))) {
    const key = formatRepoRef(ref).toLowerCase();
    if (read.has(key)) continue;
    read.add(key);
    try {
      const view = await withToken(record, (live) =>
        fetchPulls(live.token, ref, "open"),
      );
      await writePullsCache(record, ref, "open", view);
      out.push({ slug, view });
    } catch {
      // One repo out of reach must not cost the others their notifications.
    }
  }
  return out;
}

/** One in-flight device flow, so a second Connect click cannot start another. */
let connecting: AbortController | null = null;

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("That value is required.");
  if (value.length > max) throw new Error("That value is too long.");
  return value;
}

function slugArg(args: unknown[], count: number): string[] {
  if (args.length !== count) throw new Error("A project is required.");
  return [text(args[0], 200), ...args.slice(1).map(String)];
}

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

const pendingMerges = new Set<string>();

/**
 * A commit, as a URL will accept it.
 *
 * ⚠️ Hex and nothing else. Every sha here arrives from the renderer and is
 * pasted into a path main fetches, so the shape is checked rather than trusted
 * — the same rule `parseRepoRef` states for a repository name.
 */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

const VERDICTS = new Set<ReviewVerdict>([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
]);

export function registerGit(devUrl?: string): void {
  registerWorktree(devUrl);

  handle(gitChannels.account, devUrl, async (): Promise<GitAccount> => {
    return account(await readToken(await authorizedRecord()));
  });

  handle(gitChannels.connect, devUrl, async (): Promise<GitAccount> => {
    const record = await authorizedRecord();
    if (connecting) throw new Error("A GitHub connection is already running.");
    const controller = new AbortController();
    connecting = controller;
    try {
      const { deviceCode, ...progress } = await requestDeviceCode();
      // ⚠️ Sent, not returned. The code exists minutes before this promise
      // settles, and it is the only thing on screen while a human is off
      // approving it.
      broadcast(gitChannels.connectProgress, progress);

      const issued = await pollForToken(
        deviceCode,
        progress.interval,
        controller.signal,
      );
      const viewer = await fetchViewer(issued.token);
      await writeToken(record, {
        token: issued.token,
        refreshToken: issued.refreshToken,
        expiresAt: issued.expiresAt,
        login: viewer.login,
        name: viewer.name,
        avatarUrl: viewer.avatarUrl,
      });
      return announce(account(await readToken(record)));
    } catch (error) {
      if (error instanceof DeviceFlowError && error.code === "cancelled")
        throw new Error("Connection cancelled.");
      throw error;
    } finally {
      if (connecting === controller) connecting = null;
    }
  });

  handle(gitChannels.connectCancel, devUrl, async (): Promise<void> => {
    connecting?.abort();
  });

  handle(gitChannels.disconnect, devUrl, async (): Promise<GitAccount> => {
    const record = await authorizedRecord();
    await clearToken(record);
    // ⚠️ Repo links survive. They are not secret, and a user who reconnects
    // should not have to point every project at its repository again.
    return announce({ kind: "none" });
  });

  handle(gitChannels.repo, devUrl, async (args): Promise<RepoState> => {
    const [slug] = slugArg(args, 1);
    return repoState(await authorizedRecord(), slug);
  });

  handle(gitChannels.repoOptions, devUrl, async (): Promise<RepoOptions> => {
    // ⚠️ No slug, and no cache. This is a property of the account rather than of
    // a project, and it is read once when somebody opens the picker — caching a
    // list of repositories would mean showing a repo created five minutes ago
    // as not existing.
    const record = await authorizedRecord();
    return withToken(record, (token) => fetchRepoOptions(token.token));
  });

  handle(gitChannels.appAccess, devUrl, async (): Promise<GitAppAccess> => {
    const record = await authorizedRecord();
    return withToken(record, async (token) => {
      // ⚠️ A refusal is an ANSWER, not a failure: a classic OAuth App's token is
      // rejected by this route, and that tells the screen which KIND of app it
      // is talking to — not that there is nothing to configure.
      const found = await fetchInstallations(token.token).catch(() => null);
      return { installations: found?.installations ?? [] };
    });
  });

  handle(gitChannels.openAppConfig, devUrl, async (args): Promise<void> => {
    if (args.length !== 1) throw new Error("An installation is required.");
    const wanted = args[0];
    if (wanted !== null && typeof wanted !== "number")
      throw new Error("That is not an installation.");

    const record = await authorizedRecord();
    const found = await withToken(record, (token) =>
      fetchInstallations(token.token),
    ).catch(() => null);

    // ⚠️ The URL is built HERE, from an id checked against what this account
    // actually has. The renderer names an installation; it never names an
    // address, so this channel cannot be asked to open an arbitrary page.
    //
    // ⚠️ Three destinations because there are three real situations, and the
    // last one is not a fallback for failure — it is the ONLY correct page for
    // a classic OAuth App, whose token cannot list installations at all. That
    // page is also where an organisation's third-party access is granted, which
    // is the usual reason a repository somebody can see in a browser is missing
    // from this list.
    const match = found?.installations.find((entry) => entry.id === wanted);
    const url = match
      ? `https://github.com/settings/installations/${match.id}`
      : found?.appSlug
        ? `https://github.com/apps/${found.appSlug}/installations/select_target`
        : `https://github.com/settings/connections/applications/${clientId()}`;

    // ⚠️ The OS browser, not a window in this app. The person is already signed
    // in to GitHub there; a GitHub session inside an Electron window would be a
    // credential this app is holding on their behalf, for a page whose whole
    // job is granting access.
    await shell.openExternal(url).catch(() => {});
  });

  handle(gitChannels.linkRepo, devUrl, async (args): Promise<RepoState> => {
    if (args.length !== 2)
      throw new Error("A project and repository are required.");
    const slug = text(args[0], 200);
    // ⚠️ The ONE place a renderer-supplied repository name enters this process.
    // It is parsed and re-formed here — never concatenated into a URL as typed
    // — which is what stops this channel from being a way to fetch anything.
    const ref = parseRepoRef(text(args[1], 300));
    if (!ref)
      throw new Error(
        "That does not look like a repository. Use the owner/repo form.",
      );
    const record = await authorizedRecord();
    await writeRepo(record, slug, ref);
    return { kind: "linked", repo: ref };
  });

  handle(gitChannels.unlinkRepo, devUrl, async (args): Promise<RepoState> => {
    const [slug] = slugArg(args, 1);
    const record = await authorizedRecord();
    await writeRepo(record, slug, null);
    return repoState(record, slug);
  });

  handle(gitChannels.pulls, devUrl, async (args): Promise<PullsView> => {
    if (args.length !== 3) throw new Error("A project is required.");
    const slug = text(args[0], 200);
    const status = args[1] as PullStatus;
    if (!PULL_STATUSES.includes(status))
      throw new Error("That is not a pull request state.");
    const refresh = args[2] === true;
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);

    const cached = await readPullsCache(record, ref, status);
    if (!refresh && cached && fresh(cached)) return { ...cached, stale: false };

    try {
      const view = await withToken(record, (token) =>
        fetchPulls(token.token, ref, status),
      );
      await writePullsCache(record, ref, status, view);
      return view;
    } catch (error) {
      // ⚠️ The last good copy, LABELLED. An empty list would read as "no open
      // pull requests", which is a different fact than "I could not ask".
      if (cached) return cached;
      throw error;
    }
  });

  handle(gitChannels.pull, devUrl, async (args): Promise<PullDetail> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    return withToken(record, (token) =>
      fetchPull(token.token, ref, number, token.login),
    );
  });

  handle(gitChannels.commits, devUrl, async (args): Promise<PullCommit[]> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    return withToken(record, (token) =>
      fetchPullCommits(token.token, ref, number),
    );
  });

  handle(gitChannels.commitDiff, devUrl, async (args): Promise<CommitDiff> => {
    if (args.length !== 2) throw new Error("A commit is required.");
    const slug = text(args[0], 200);
    const sha = text(args[1], 100);
    // ⚠️ The same guard `fileText` states, for the same reason: this value is
    // the renderer's, and it goes straight into a URL main fetches.
    if (!COMMIT_SHA.test(sha)) throw new Error("That is not a valid commit.");
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    return withToken(record, (token) => fetchCommitDiff(token.token, ref, sha));
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
      const record = await authorizedRecord();
      const ref = await linkedRepo(record, slug);
      return withToken(record, (token) =>
        fetchFileText(token.token, ref, path, sha),
      );
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
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    await withToken(record, async (token) => {
      const key = `${token.login}/${ref.owner}/${ref.repo}/${number}`;
      if (pendingMerges.has(key))
        throw new Error(
          "A merge is already in progress for this pull request.",
        );
      pendingMerges.add(key);
      try {
        await mergePull(token.token, ref, number, method, sha);
      } finally {
        pendingMerges.delete(key);
      }
    });
  });

  handle(gitChannels.review, devUrl, async (args): Promise<void> => {
    if (args.length !== 4) throw new Error("A review is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const verdict = args[2] as ReviewVerdict;
    if (!VERDICTS.has(verdict)) throw new Error("That is not a review.");
    const body = typeof args[3] === "string" ? args[3] : "";
    if (body.length > 60_000) throw new Error("That review is too long.");
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    await withToken(record, (token) =>
      submitReview(token.token, ref, number, verdict, body, token.login),
    );
  });

  // ⚠️ Keyed by `slug`, like every other read here — the renderer never names a
  // repository. `linkedRepo` is what turns a project into an `owner/repo`, in
  // main, from something a person confirmed once at connect time.
  handle(gitChannels.activity, devUrl, async (args): Promise<PullActivity> => {
    if (args.length !== 2) throw new Error("A pull request is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    return withToken(record, (token) =>
      fetchPullActivity(token.token, ref, number),
    );
  });

  handle(gitChannels.comment, devUrl, async (args): Promise<void> => {
    if (args.length !== 3) throw new Error("A comment is required.");
    const slug = text(args[0], 200);
    const number = positive(args[1]);
    const body = typeof args[2] === "string" ? args[2] : "";
    // The same ceiling `review` applies. A body this long is a paste accident,
    // and GitHub would refuse it after we had spent the request.
    if (body.length > 60_000) throw new Error("That comment is too long.");
    const record = await authorizedRecord();
    const ref = await linkedRepo(record, slug);
    await withToken(record, (token) =>
      addComment(token.token, ref, number, body),
    );
  });
}
