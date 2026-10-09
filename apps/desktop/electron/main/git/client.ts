import {
  type CheckState,
  type CommitDiff,
  type FileText,
  type GitInstallation,
  MAX_PULL_CHECKS,
  MAX_PULL_FILES,
  MAX_REPO_OPTIONS,
  MAX_TIMELINE_ITEMS,
  MERGE_METHODS,
  type MergeMethod,
  type PullActivity,
  type PullCheck,
  type PullChecks,
  type PullCommit,
  type PullDetail,
  type PullFile,
  type PullFileStatus,
  type PullMergeState,
  type PullRequest,
  type PullState,
  type PullStatus,
  type PullsView,
  type PullTimelineItem,
  type RepoOption,
  type RepoOptions,
  type RepoRef,
  type ReviewVerdict,
} from "../../../shared/git";

/**
 * Talking to GitHub, from the main process only.
 *
 * ⚠️ Nothing here is reachable from a window. The renderer runs on
 * `app://lanework` (see `main/security.ts`), so it could not call
 * `api.github.com` even if it wanted to — and more to the point, a token that
 * crossed into a web origin would be readable by anything that achieves script
 * execution there. Every function takes the token as an argument and none of
 * them returns it.
 *
 * ⚠️ Hand-written `fetch`, no `@octokit/*`. This needs five endpoints; Octokit
 * brings pagination, throttling and plugin machinery for the other two hundred.
 */

/**
 * The GitHub API origin.
 *
 * ⚠️ A function, not a constant, and overridable for the same reason
 * `resolveApi` is on the control-plane side: the test suite has to be able to
 * answer these calls itself. A build that could only ever reach
 * `api.github.com` is one whose pull-request screen can only be tested against
 * the real thing, over the network, with somebody's real token.
 */
function api(): string {
  return (
    process.env.LANEWORK_GITHUB_API_URL || "https://api.github.com"
  ).replace(/\/+$/, "");
}

/** Identifies this client to GitHub; required on every request. */
const UA = "Lanework-Desktop";

/**
 * A GitHub refusal, with the one bit of it a caller has to branch on.
 *
 * ⚠️ `status` is carried because 401 is not like the others: it means the token
 * is finished, and the account has to be marked `expired` so the UI offers
 * "reconnect" instead of retrying forever against a dead credential.
 */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitHubError";
  }
}

function ratelimited(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get("x-ratelimit-remaining") === "0"
  );
}

/** When the hourly budget refills, as a sentence rather than an epoch. */
function resetAt(response: Response): string {
  const raw = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(raw) || raw <= 0) return "shortly";
  const at = new Date(raw * 1000);
  const minutes = Math.max(1, Math.round((at.getTime() - Date.now()) / 60_000));
  return minutes > 60 ? "in about an hour" : `in about ${minutes} minutes`;
}

async function request(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new GitHubError(
      0,
      "Could not reach GitHub. Check your connection and try again.",
    );
  }

  if (response.status === 401)
    throw new GitHubError(
      401,
      "GitHub no longer accepts this connection. Connect again to continue.",
    );
  if (ratelimited(response))
    throw new GitHubError(
      403,
      `GitHub's hourly request limit is used up. It resets ${resetAt(response)}.`,
    );
  if (response.status === 403)
    throw new GitHubError(
      403,
      "GitHub refused that request. The app may not have access to this repository.",
    );
  if (response.status === 404)
    throw new GitHubError(
      404,
      "That repository does not exist, or this connection cannot see it.",
    );
  if ([405, 409, 422].includes(response.status)) {
    const data = record(await response.json().catch(() => null));
    const reasons = Array.isArray(data?.errors)
      ? data.errors
          .slice(0, 3)
          .map((error) =>
            typeof error === "string" ? error : str(record(error)?.message),
          )
          .filter(Boolean)
      : [];
    const message = [str(data?.message), ...reasons]
      .filter(Boolean)
      .join(". ")
      .replace(/\p{Cc}/gu, " ")
      .slice(0, 300);
    throw new GitHubError(
      response.status,
      message ||
        (response.status === 409
          ? "The pull request changed. Refresh before trying again."
          : response.status === 405
            ? "GitHub cannot merge this pull request. Check its branch rules."
            : "GitHub could not accept this action. Check the pull request and try again."),
    );
  }
  if (!response.ok)
    throw new GitHubError(
      response.status,
      `GitHub answered ${response.status}. Try again.`,
    );

  return response;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubError(0, "GitHub returned an unreadable response.");
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Who this token belongs to. */
export async function fetchViewer(token: string): Promise<{
  login: string;
  name: string | null;
  avatarUrl: string | null;
}> {
  const data = record(await json(await request(token, `${api()}/user`)));
  const login = str(data?.login);
  if (!login)
    throw new GitHubError(0, "GitHub did not say who this connection is for.");
  return {
    login,
    name: str(data?.name),
    avatarUrl: str(data?.avatar_url),
  };
}

/**
 * Every open pull request on a repo, in ONE request.
 *
 * ⚠️ GraphQL here and REST everywhere else, and the reason is a hard limit of
 * the REST list: `GET /pulls` does not carry `additions`, `deletions` or
 * `changed_files`. Only a single-PR read does — so drawing `+36 −24` on 25 rows
 * would be 26 round trips, against an hourly budget, every time somebody opens
 * the screen. One GraphQL query answers the rows, their diff counts, their
 * requested reviewers and the viewer's own login, and costs a single point.
 *
 * ⚠️ No `If-None-Match` on this one. Conditional requests are a GET feature and
 * GraphQL is a POST, so the cheap re-read is the on-disk cache plus the refresh
 * rules in `index.ts`, not a 304.
 */
const PULLS_QUERY = `query($owner:String!,$name:String!,$first:Int!,$states:[PullRequestState!]){
  viewer{login}
  repository(owner:$owner,name:$name){
    pullRequests(states:$states,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number title url state isDraft createdAt updatedAt
        additions deletions changedFiles
        author{login avatarUrl}
        headRefName baseRefName reviewDecision
        reviewRequests(first:25){nodes{requestedReviewer{__typename ... on User{login}}}}
      }
    }
  }
}`;

/** How many pull requests one read brings back. A screen, not an archive. */
const PULLS_PAGE = 50;

async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request(token, `${api()}/graphql`, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const data = record(await json(response));
  const errors = data?.errors;
  if (Array.isArray(errors) && errors.length) {
    const first = record(errors[0]);
    const type = str(first?.type);
    const message = str(first?.message) ?? "GitHub refused that query.";
    // GraphQL reports "no such repo" as a 200 with NOT_FOUND in the body; the
    // caller has to see the same error it would get from REST.
    if (type === "NOT_FOUND")
      throw new GitHubError(
        404,
        "That repository does not exist, or this connection cannot see it.",
      );
    if (type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES")
      throw new GitHubError(
        403,
        "This connection is not allowed to read that repository.",
      );
    throw new GitHubError(0, message);
  }
  const payload = record(data?.data);
  if (!payload)
    throw new GitHubError(0, "GitHub returned an unreadable response.");
  return payload;
}

/**
 * The states GitHub is asked for.
 *
 * ⚠️ `null` for "all", not the three of them listed. A null `states` argument
 * means "do not filter", which is the server's own default — spelling out a
 * list would make this app responsible for keeping up with a state GitHub adds
 * later.
 */
function statesFor(status: PullStatus): string[] | null {
  if (status === "all") return null;
  return [status.toUpperCase()];
}

function toState(raw: string | null): PullState {
  const value = (raw ?? "").toLowerCase();
  return value === "merged" || value === "closed" ? value : "open";
}

export async function fetchPulls(
  token: string,
  ref: RepoRef,
  status: PullStatus,
): Promise<PullsView> {
  const data = await graphql(token, PULLS_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    first: PULLS_PAGE,
    states: statesFor(status),
  });

  const viewer = str(record(data.viewer)?.login);
  const repository = record(data.repository);
  if (!repository)
    throw new GitHubError(
      404,
      "That repository does not exist, or this connection cannot see it.",
    );

  const nodes = record(repository.pullRequests)?.nodes;
  const pulls: PullRequest[] = [];
  if (Array.isArray(nodes))
    for (const entry of nodes) {
      const node = record(entry);
      if (!node || typeof node.number !== "number") continue;
      const author = record(node.author);
      const login = str(author?.login);

      const requested = record(node.reviewRequests)?.nodes;
      const reviewRequested =
        Array.isArray(requested) && viewer
          ? requested.some(
              (item) =>
                str(record(record(item)?.requestedReviewer)?.login) === viewer,
            )
          : false;

      pulls.push({
        number: node.number,
        title: str(node.title) ?? "(untitled)",
        url: str(node.url) ?? "",
        state: toState(str(node.state)),
        author: login ? { login, avatarUrl: str(author?.avatarUrl) } : null,
        headRef: str(node.headRefName) ?? "",
        baseRef: str(node.baseRefName) ?? "",
        draft: node.isDraft === true,
        additions: num(node.additions),
        deletions: num(node.deletions),
        changedFiles: num(node.changedFiles),
        createdAt: str(node.createdAt) ?? "",
        updatedAt: str(node.updatedAt) ?? "",
        reviewRequested,
        authored: Boolean(
          viewer && login?.toLowerCase() === viewer.toLowerCase(),
        ),
        reviewDecision: str(node.reviewDecision),
      });
    }

  return {
    repo: ref,
    status,
    viewer,
    pulls,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

/**
 * Every repository this connection can reach, newest push first.
 *
 * ⚠️ TWO sources, because there are two kinds of GitHub app and this code does
 * not get told which one it is talking to. A classic OAuth App's token answers
 * `viewer.repositories` with everything the person can see. A GitHub App's
 * user token is scoped to INSTALLATIONS — and against one of those the same
 * query can come back empty while the person plainly has repositories. Empty is
 * therefore treated as "ask the other way" rather than as an answer, and the
 * REST installations route is that other way.
 *
 * ⚠️ A picker's worth of round trips and no more. `MAX_REPO_OPTIONS` stops the
 * paging, and `capped` says so on screen — typing the name still works for a
 * repository past the cut.
 */
/**
 * Every repository this connection can reach, from `GET /user/repos`.
 *
 * ⚠️ REST rather than GraphQL, and this is the second attempt. `viewer.
 * repositories` takes BOTH `affiliations` and `ownerAffiliations`, and the
 * second one defaults to `[OWNER, COLLABORATOR]` — so a query that explicitly
 * asked for `ORGANIZATION_MEMBER` had organisation repositories filtered back
 * out by a default it never named. Observed: an org with third-party access
 * granted simply did not appear in the picker. This endpoint has no argument
 * that quietly contradicts another one.
 *
 * ⚠️ `sort=pushed` is what makes the picker's first screen the useful one, and
 * the owner list downstream is ordered by first appearance here for the same
 * reason — the account somebody pushed to most recently is the one they are
 * most likely connecting.
 */
async function reposByUser(token: string): Promise<RepoOption[]> {
  const out: RepoOption[] = [];
  for (let page = 1; out.length < MAX_REPO_OPTIONS; page++) {
    const rows = await json(
      await request(
        token,
        `${api()}/user/repos?per_page=100&page=${page}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`,
      ),
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const item of rows) {
      const row = record(item);
      const option = toOption(
        str(record(row?.owner)?.login),
        row,
        str(row?.pushed_at),
      );
      if (option) out.push(option);
    }
    if (rows.length < 100) break;
  }
  return out;
}

function toOption(
  owner: string | null,
  row: Record<string, unknown> | null,
  pushed: string | null,
): RepoOption | null {
  const name = str(row?.name);
  if (!owner || !name) return null;
  return {
    owner,
    repo: name,
    fullName: `${owner}/${name}`,
    private: row?.isPrivate === true || row?.private === true,
    pushedAt: pushed,
  };
}

/**
 * Where this app is installed, and under what slug GitHub knows it.
 *
 * ⚠️ The slug comes from HERE rather than from a constant. A GitHub App's
 * install page is `github.com/apps/<slug>/…`, and the slug is not derivable
 * from the client id — hard-coding one would send people to a 404 the day the
 * app is renamed.
 *
 * ⚠️ A classic OAuth App's token is refused by this route, and that is the
 * signal rather than an error: no installations means there is nothing to
 * configure, which is exactly what the screen needs to know.
 */
export async function fetchInstallations(token: string): Promise<{
  installations: GitInstallation[];
  appSlug: string | null;
}> {
  const body = record(
    await json(
      await request(token, `${api()}/user/installations?per_page=100`),
    ),
  );
  const rows = body?.installations;
  if (!Array.isArray(rows)) return { installations: [], appSlug: null };

  const installations: GitInstallation[] = [];
  let appSlug: string | null = null;
  for (const entry of rows) {
    const row = record(entry);
    const id = row?.id;
    if (typeof id !== "number") continue;
    // A slug becomes part of a URL this app opens, so it is checked here rather
    // than trusted from a response body.
    const slug = str(row?.app_slug);
    if (!appSlug && slug && /^[a-z0-9-]+$/i.test(slug)) appSlug = slug;
    installations.push({
      id,
      account: str(record(row?.account)?.login) ?? "",
    });
  }
  return { installations, appSlug };
}

async function reposByInstallation(token: string): Promise<RepoOption[]> {
  const { installations } = await fetchInstallations(token);
  const out: RepoOption[] = [];
  for (const { id } of installations) {
    for (let page = 1; out.length < MAX_REPO_OPTIONS; page++) {
      const body = record(
        await json(
          await request(
            token,
            `${api()}/user/installations/${id}/repositories?per_page=100&page=${page}`,
          ),
        ),
      );
      const rows = body?.repositories;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const item of rows) {
        const row = record(item);
        const option = toOption(
          str(record(row?.owner)?.login),
          row,
          str(row?.pushed_at),
        );
        if (option) out.push(option);
      }
      if (rows.length < 100) break;
    }
  }
  return out;
}

export async function fetchRepoOptions(token: string): Promise<RepoOptions> {
  // ⚠️ Two sources, because there are two kinds of GitHub app. A classic OAuth
  // App answers `/user/repos`; a GitHub App's user token is refused by it and
  // reports through installations instead. Empty and refused are treated the
  // same — as "ask the other way" — because both mean this route knows nothing.
  const mine = await reposByUser(token).catch(() => []);
  const repos = mine.length
    ? mine
    : await reposByInstallation(token).catch(() => []);

  // The installation route pages per installation, so its rows arrive grouped
  // rather than by recency. Sorting here means the picker's order is the same
  // whichever route answered.
  repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));

  return {
    repos: repos.slice(0, MAX_REPO_OPTIONS),
    capped: repos.length > MAX_REPO_OPTIONS,
  };
}

const FILE_STATUS = new Set<PullFileStatus>([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

function toFile(entry: unknown): PullFile | null {
  const row = record(entry);
  const path = str(row?.filename);
  if (!path) return null;
  const status = str(row?.status);
  return {
    path,
    previousPath: str(row?.previous_filename),
    status:
      status && FILE_STATUS.has(status as PullFileStatus)
        ? (status as PullFileStatus)
        : "modified",
    additions: num(row?.additions),
    deletions: num(row?.deletions),
    // Absent for binary files and for diffs GitHub considers too large. Null
    // travels as null: the viewer says which of the two it is looking at.
    patch: str(row?.patch),
  };
}

function mergeState(
  data: Record<string, unknown>,
  repository: Record<string, unknown> | null,
): PullMergeState {
  const permissions = record(repository?.permissions);
  return {
    mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null,
    state: str(data.mergeable_state),
    canMerge:
      permissions?.push === true ||
      permissions?.maintain === true ||
      permissions?.admin === true,
    methods: MERGE_METHODS.filter(
      (method) =>
        repository?.[
          method === "merge" ? "allow_merge_commit" : `allow_${method}_merge`
        ] === true,
    ),
  };
}

export async function mergePull(
  token: string,
  ref: RepoRef,
  number: number,
  method: MergeMethod,
  headSha: string,
): Promise<void> {
  if (!MERGE_METHODS.includes(method) || !/^[0-9a-f]{40,64}$/i.test(headSha))
    throw new GitHubError(
      422,
      "A valid merge method and full head commit are required.",
    );
  const root = `${api()}/repos/${ref.owner}/${ref.repo}`;
  const [pull, repository] = await Promise.all([
    request(token, `${root}/pulls/${number}`).then(json).then(record),
    request(token, root).then(json).then(record),
  ]);
  if (!pull || !repository)
    throw new GitHubError(0, "GitHub returned an unreadable response.");
  const state = mergeState(pull, repository);
  if (pull.state !== "open" || pull.merged === true)
    throw new GitHubError(
      422,
      "This pull request is no longer open. Refresh it.",
    );
  if (pull.draft === true)
    throw new GitHubError(
      422,
      "Mark this pull request ready for review before merging.",
    );
  if (str(record(pull.head)?.sha)?.toLowerCase() !== headSha.toLowerCase())
    throw new GitHubError(
      409,
      "The head commit changed. Refresh and review the new changes before merging.",
    );
  if (!state.canMerge)
    throw new GitHubError(
      403,
      "Write access to this repository is required to merge.",
    );
  if (!state.methods.includes(method))
    throw new GitHubError(
      422,
      "This merge method is disabled in the repository settings.",
    );
  if (
    state.mergeable !== true ||
    !state.state ||
    !["clean", "unstable", "has_hooks"].includes(state.state)
  )
    throw new GitHubError(
      405,
      state.mergeable === false || state.state === "dirty"
        ? "Resolve the merge conflicts before merging."
        : state.state === "blocked"
          ? "Branch rules or required checks currently block this merge."
          : "GitHub is still calculating mergeability. Refresh and try again.",
    );
  const result = record(
    await json(
      await request(token, `${root}/pulls/${number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: method, sha: headSha }),
      }),
    ),
  );
  if (result?.merged !== true)
    throw new GitHubError(
      405,
      str(result?.message)
        ?.replace(/\p{Cc}/gu, " ")
        .slice(0, 300) ||
        "GitHub did not merge this pull request. Refresh and check its branch rules.",
    );
}

/**
 * One pull request and its diff.
 *
 * ⚠️ REST, not GraphQL, and for the opposite reason to `fetchPulls`: the diff
 * text itself is a REST-only field. GraphQL will describe a file list but will
 * not hand over the patch hunks this app renders.
 */
export async function fetchPull(
  token: string,
  ref: RepoRef,
  number: number,
  viewer: string | null,
): Promise<PullDetail> {
  const base = `${api()}/repos/${ref.owner}/${ref.repo}/pulls/${number}`;
  const data = record(await json(await request(token, base)));
  if (!data)
    throw new GitHubError(0, "GitHub returned an unreadable response.");

  const repository = await request(
    token,
    `${api()}/repos/${ref.owner}/${ref.repo}`,
  )
    .then(json)
    .then(record)
    .catch(() => null);
  const author = record(data.user);
  const login = str(author?.login);
  const requested = data.requested_reviewers;
  const head = record(data.head);
  // ⚠️ Named `target` because `base` is already this function's request URL.
  const target = record(data.base);
  const headSha = str(head?.sha);
  if (!headSha)
    throw new GitHubError(
      0,
      "GitHub did not say which commit to diff against.",
    );

  const pull: PullRequest = {
    number,
    title: str(data.title) ?? "(untitled)",
    url: str(data.html_url) ?? "",
    // ⚠️ REST says `state: "closed"` for a merged pull request and reports the
    // merge separately. Reading only `state` would file every shipped change
    // under "thrown away".
    state: data.merged === true ? "merged" : toState(str(data.state)),
    author: login ? { login, avatarUrl: str(author?.avatar_url) } : null,
    headRef: str(head?.ref) ?? "",
    baseRef: str(target?.ref) ?? "",
    draft: data.draft === true,
    additions: num(data.additions),
    deletions: num(data.deletions),
    changedFiles: num(data.changed_files),
    createdAt: str(data.created_at) ?? "",
    updatedAt: str(data.updated_at) ?? "",
    reviewRequested:
      Array.isArray(requested) && viewer
        ? requested.some((item) => str(record(item)?.login) === viewer)
        : false,
    authored: Boolean(viewer && login?.toLowerCase() === viewer.toLowerCase()),
    // REST does not carry `reviewDecision`; the list read is where that fact
    // comes from, and inventing one here would contradict it.
    reviewDecision: null,
  };

  const files: PullFile[] = [];
  let truncated = false;
  for (let page = 1; files.length < MAX_PULL_FILES; page++) {
    const rows = await json(
      await request(token, `${base}/files?per_page=100&page=${page}`),
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const file = toFile(row);
      if (file) files.push(file);
    }
    if (rows.length < 100) break;
    if (files.length >= MAX_PULL_FILES) {
      truncated = true;
      break;
    }
  }

  return {
    repo: ref,
    pull,
    body: str(data.body) ?? "",
    merge: mergeState(data, repository),
    headSha,
    // ⚠️ Empty rather than a throw. A pull request always has a base, but a diff
    // still renders without one — only EXPANDING it needs the old side, and a
    // missing base sha must cost the expander, not the whole screen.
    baseSha: str(target?.sha) ?? "",
    files: files.slice(0, MAX_PULL_FILES),
    truncated: truncated || files.length > MAX_PULL_FILES,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * How many commits of one pull request this app lists.
 *
 * ⚠️ A cap, and a menu-sized one. This feeds a dropdown somebody scrolls with a
 * pointer; a branch with four hundred commits does not become more reviewable
 * for having all four hundred in a list, and the pull request's own diff is
 * what that person wants anyway.
 */
const MAX_PULL_COMMITS = 250;

/**
 * The commits in a pull request, oldest first.
 *
 * ⚠️ GitHub's own order, not sorted here. REST returns them in topological
 * order, which is the order they were written — re-sorting by date would put a
 * rebased or cherry-picked commit in a position its branch never had.
 */
export async function fetchPullCommits(
  token: string,
  ref: RepoRef,
  number: number,
): Promise<PullCommit[]> {
  const base = `${api()}/repos/${ref.owner}/${ref.repo}/pulls/${number}/commits`;
  const commits: PullCommit[] = [];
  for (let page = 1; commits.length < MAX_PULL_COMMITS; page++) {
    const rows = await json(
      await request(token, `${base}?per_page=100&page=${page}`),
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const commit = toCommit(row);
      if (commit) commits.push(commit);
    }
    if (rows.length < 100) break;
  }
  return commits.slice(0, MAX_PULL_COMMITS);
}

function toCommit(entry: unknown): PullCommit | null {
  const row = record(entry);
  const sha = str(row?.sha);
  if (!sha) return null;
  const commit = record(row?.commit);
  const message = str(commit?.message) ?? "";
  // ⚠️ `commit.author` is who WROTE it and is always present; `author` is the
  // GitHub account it was matched to and is null for an unmatched email. The
  // login is the better label when there is one, and the written name is the
  // only thing there is when there is not.
  const account = record(row?.author);
  const written = record(commit?.author);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    // The subject line. A commit with no message at all still needs a label,
    // and its sha is already beside it.
    subject: message.split("\n", 1)[0].trim() || "(no message)",
    authorLogin: str(account?.login) ?? str(written?.name),
    committedAt: str(written?.date) ?? "",
  };
}

/**
 * One commit's diff, against its parent.
 *
 * ⚠️ `/commits/{sha}`, which answers with the same `files[]` shape the pull
 * request's file list uses — so `toFile` is shared and the renderer cannot tell
 * the two apart. A `compare` call would give a different shape for the same
 * information and a second parser to keep in step.
 */
export async function fetchCommitDiff(
  token: string,
  ref: RepoRef,
  sha: string,
): Promise<CommitDiff> {
  const url = `${api()}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(sha)}`;
  const data = record(await json(await request(token, url)));
  if (!data)
    throw new GitHubError(0, "GitHub returned an unreadable response.");

  const headSha = str(data.sha) ?? sha;
  const parents = Array.isArray(data.parents) ? data.parents : [];
  // ⚠️ The FIRST parent. On a merge commit the second parent is the branch that
  // was merged in, and diffing against it would present the whole of the other
  // side as this commit's work.
  const baseSha = str(record(parents[0])?.sha) ?? "";

  const rows = Array.isArray(data.files) ? data.files : [];
  const files: PullFile[] = [];
  for (const row of rows) {
    const file = toFile(row);
    if (file) files.push(file);
  }

  return {
    sha: headSha,
    headSha,
    baseSha,
    files: files.slice(0, MAX_PULL_FILES),
    // ⚠️ GitHub itself caps this response at 300 files and says so only by
    // sending 300; there is no flag. The cap is the same number this app uses,
    // so a commit at it is reported as truncated rather than as complete.
    truncated: files.length >= MAX_PULL_FILES,
  };
}

/** A file big enough that reading it whole is not worth it for context lines. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/**
 * One file's contents at a commit, or null.
 *
 * ⚠️ Null for every reason a file cannot be read — absent on this side, too
 * large, binary. The caller is a diff that is already on screen, and none of
 * those is worth replacing it with an error: they all mean the same thing to a
 * reader, which is that the unchanged lines stay folded.
 */
export async function fetchFileText(
  token: string,
  ref: RepoRef,
  path: string,
  sha: string,
): Promise<FileText | null> {
  const url = `${api()}/repos/${ref.owner}/${ref.repo}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}?ref=${encodeURIComponent(sha)}`;

  let response: Response;
  try {
    response = await request(token, url, {
      headers: { accept: "application/vnd.github.raw" },
    });
  } catch (error) {
    // A 404 here is the normal case for the old side of an added file.
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }

  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BLOB_BYTES) return null;

  const text = await response.text();
  if (text.length > MAX_BLOB_BYTES) return null;
  return { text };
}

/**
 * Approve, request changes, or comment on a pull request.
 *
 * ⚠️ PR-level only — no line comments. Those carry a position (`path`, `line`,
 * `side`, `commit_id`) this app has no model for yet, and a signature that
 * could take them would promise a feature the screen does not have.
 */
export async function submitReview(
  token: string,
  ref: RepoRef,
  number: number,
  verdict: ReviewVerdict,
  body: string,
  viewer?: string | null,
): Promise<void> {
  if (verdict !== "COMMENT" && viewer) {
    const pull = record(
      await json(
        await request(
          token,
          `${api()}/repos/${ref.owner}/${ref.repo}/pulls/${number}`,
        ),
      ),
    );
    if (str(record(pull?.user)?.login)?.toLowerCase() === viewer.toLowerCase())
      throw new GitHubError(
        422,
        "You cannot approve or request changes on your own pull request. Leave a comment instead.",
      );
  }
  // GitHub refuses REQUEST_CHANGES and COMMENT with an empty body; saying so
  // here is better than passing the refusal through as a 422.
  if (verdict !== "APPROVE" && !body.trim())
    throw new GitHubError(
      422,
      verdict === "COMMENT"
        ? "A comment needs something in it."
        : "Requesting changes needs a note saying what to change.",
    );

  await request(
    token,
    `${api()}/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({ event: verdict, body: body.trim() || undefined }),
    },
  );
}

/**
 * A pull request's timeline, its comments and its CI, in one query.
 *
 * ⚠️ ONE request rather than three REST calls (`/issues/{n}/timeline`,
 * `/issues/{n}/comments`, `/commits/{sha}/check-runs`). All three live on the
 * same GraphQL `PullRequest`, and this screen is behind an hourly budget.
 *
 * ⚠️ `timelineItems` asks for the LAST hundred. A pull request open for months
 * has its interesting end at the recent one, and paging forwards from the day
 * it opened would spend requests arriving there.
 *
 * ⚠️ Only four item types are requested. Asking for the rest and dropping them
 * in the parser would pay for them in the response; a dependabot pull request's
 * timeline is mostly `labeled` and `review_requested`.
 */
const ACTIVITY_QUERY = `query($owner:String!,$name:String!,$number:Int!,$items:Int!,$checks:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      createdAt
      author{login}
      timelineItems(last:$items,itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT]){
        totalCount
        nodes{
          __typename
          ... on IssueComment{id createdAt body author{login}}
          ... on PullRequestReview{id createdAt body state author{login}}
          ... on PullRequestCommit{id commit{committedDate author{user{login}}}}
        }
      }
      commits(last:1){
        nodes{
          commit{
            statusCheckRollup{
              state
              contexts(first:$checks){
                totalCount
                nodes{
                  __typename
                  ... on CheckRun{id name conclusion status detailsUrl}
                  ... on StatusContext{id context state targetUrl}
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** GitHub's two check vocabularies, narrowed to the four a reviewer acts on. */
function toCheckState(raw: string | null): CheckState {
  switch ((raw ?? "").toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "QUEUED":
    case "IN_PROGRESS":
    case "PENDING":
    case "WAITING":
    case "REQUESTED":
      return "pending";
    default:
      // ACTION_REQUIRED, CANCELLED, NEUTRAL, SKIPPED, STALE, EXPECTED — none of
      // them is a pass or a failure, and none is still running.
      return "neutral";
  }
}

function toChecks(commitNode: Record<string, unknown> | null): PullChecks {
  const rollup = record(record(commitNode?.commit)?.statusCheckRollup);
  // ⚠️ No rollup means NO CHECKS, not a failed read — see `PullChecks.state`.
  if (!rollup) return { state: null, checks: [], truncated: false };

  const contexts = record(rollup.contexts);
  const nodes = Array.isArray(contexts?.nodes) ? contexts.nodes : [];
  const checks: PullCheck[] = [];
  for (const raw of nodes) {
    const node = record(raw);
    if (!node) continue;
    const id = str(node.id);
    if (id === null) continue;
    if (node.__typename === "CheckRun") {
      // A run that has not finished has no conclusion; its `status` is what
      // says it is still going.
      const conclusion = str(node.conclusion);
      checks.push({
        id,
        name: str(node.name) ?? "Check",
        state: toCheckState(conclusion ?? str(node.status)),
        url: str(node.detailsUrl),
      });
      continue;
    }
    if (node.__typename === "StatusContext")
      checks.push({
        id,
        name: str(node.context) ?? "Status",
        state: toCheckState(str(node.state)),
        url: str(node.targetUrl),
      });
  }
  return {
    state: toCheckState(str(rollup.state)),
    checks,
    truncated: num(contexts?.totalCount) > checks.length,
  };
}

export async function fetchPullActivity(
  token: string,
  ref: RepoRef,
  number: number,
): Promise<PullActivity> {
  const data = await graphql(token, ACTIVITY_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number,
    items: MAX_TIMELINE_ITEMS,
    checks: MAX_PULL_CHECKS,
  });

  const pull = record(record(data.repository)?.pullRequest);
  if (!pull) throw new GitHubError(404, "That pull request no longer exists.");

  const items: PullTimelineItem[] = [];
  // ⚠️ Synthesised, not read from the timeline. "Opened" is not a timeline
  // item on GitHub — it is the pull request's own `createdAt` — and a timeline
  // that began at the first comment would read as if it had no beginning.
  items.push({
    kind: "opened",
    id: `opened-${number}`,
    actor: str(record(pull.author)?.login),
    at: str(pull.createdAt) ?? new Date().toISOString(),
  });

  const timeline = record(pull.timelineItems);
  const nodes = Array.isArray(timeline?.nodes) ? timeline.nodes : [];
  for (const raw of nodes) {
    const node = record(raw);
    if (!node) continue;
    const id = str(node.id);
    if (id === null) continue;

    if (node.__typename === "IssueComment") {
      items.push({
        kind: "comment",
        id,
        actor: str(record(node.author)?.login),
        at: str(node.createdAt) ?? "",
        body: str(node.body) ?? "",
      });
      continue;
    }

    if (node.__typename === "PullRequestReview") {
      items.push({
        kind: "review",
        id,
        actor: str(record(node.author)?.login),
        at: str(node.createdAt) ?? "",
        verdict: str(node.state),
        body: str(node.body) ?? "",
      });
      continue;
    }

    if (node.__typename === "PullRequestCommit") {
      const commit = record(node.commit);
      const at = str(commit?.committedDate) ?? "";
      const actor = str(record(record(commit?.author)?.user)?.login);
      // ⚠️ Folded into the PREVIOUS entry when that entry is also commits, so a
      // push of twelve becomes one `12 commits` row. Without this a dependabot
      // pull request's timeline is a wall of identical lines, and the commit
      // menu in the diff header is where individual commits are chosen anyway.
      const last = items[items.length - 1];
      if (last?.kind === "commits") {
        last.count += 1;
        last.at = at || last.at;
        continue;
      }
      items.push({ kind: "commits", id, actor, at, count: 1 });
    }
    // Anything else is skipped rather than drawn as a blank row.
  }

  // The rollup hangs off the HEAD commit, which is why the query asks for
  // `commits(last:1)` — checks belong to what is currently proposed, not to
  // whatever the branch looked like when it opened.
  const headNodes = record(pull.commits)?.nodes;
  const head = Array.isArray(headNodes) ? record(headNodes[0]) : null;

  return {
    number,
    items,
    truncated: num(timeline?.totalCount) > nodes.length,
    checks: toChecks(head),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Leave an ordinary comment on a pull request.
 *
 * ⚠️ The ISSUES endpoint, deliberately. A pull request is an issue to this API,
 * and `/pulls/{n}/reviews` — the one `submitReview` uses — would attach a
 * verdict that can block a merge. Two different acts, two different calls.
 */
export async function addComment(
  token: string,
  ref: RepoRef,
  number: number,
  body: string,
): Promise<void> {
  const text = body.trim();
  // Said here rather than passed through as GitHub's 422: an empty comment is
  // a mistake the screen can name before it spends a request on it.
  if (!text) throw new GitHubError(422, "A comment needs something in it.");

  await request(
    token,
    `${api()}/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`,
    { method: "POST", body: JSON.stringify({ body: text }) },
  );
}
