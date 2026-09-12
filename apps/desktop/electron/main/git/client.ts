import {
  type FileText,
  type GitInstallation,
  MAX_PULL_FILES,
  MAX_REPO_OPTIONS,
  type PullDetail,
  type PullFile,
  type PullFileStatus,
  type PullRequest,
  type PullState,
  type PullStatus,
  type PullsView,
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
        authored: Boolean(viewer && login === viewer),
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
    authored: Boolean(viewer && login === viewer),
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
): Promise<void> {
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
