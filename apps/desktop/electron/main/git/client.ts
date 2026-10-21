// Pull requests through `gh pr …`, from the main process only.
//
// - A subcommand wherever `gh` has one. `gh api` is used only for what no
//   subcommand reads: one commit's diff and one file at one commit.
// - Every argument here is validated before it is built: a repo is a parsed
//   `RepoRef`, a number is an integer, a sha is hex. Free text (a review, a
//   comment) goes through stdin, never argv.
import {
  type CheckState,
  type CommitDiff,
  type FileText,
  formatRepoRef,
  MAX_PULL_CHECKS,
  MAX_PULL_FILES,
  MAX_TIMELINE_ITEMS,
  MERGE_METHODS,
  type MergeMethod,
  type PullActivity,
  type PullAuthor,
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
  type RepoRef,
  type ReviewVerdict,
} from "../../../shared/git";
import { GitHubError, gh, ghJson } from "./gh";

export { GitHubError } from "./gh";

/** `value` when it is a non-empty string, else null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `value` when it is a finite number, else 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `value` when it is a plain object, else null. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `value` when it is an array, else an empty one. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A repo as `gh --repo` takes it: `owner/name`. */
function repoArg(ref: RepoRef): string {
  return formatRepoRef(ref);
}

/**
 * An avatar for a login.
 *
 * `gh` does not return avatar URLs. GitHub serves one at this address for
 * every user login. A bot login such as `app/dependabot` has a slash in it
 * and gets none.
 */
function avatarFor(login: string): string | null {
  return /^[A-Za-z0-9-]+$/.test(login)
    ? `https://avatars.githubusercontent.com/${login}`
    : null;
}

/** An author from `gh`'s `{ login }`; null when it has no login. */
function toAuthor(value: unknown): PullAuthor | null {
  const login = str(record(value)?.login);
  return login ? { login, avatarUrl: avatarFor(login) } : null;
}

/** A pull request's state; anything not merged or closed reads as open. */
function toState(raw: string | null): PullState {
  const value = (raw ?? "").toLowerCase();
  return value === "merged" || value === "closed" ? value : "open";
}

/** Whether two logins or shas are both set and equal, ignoring case. */
function same(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** The fields one row of the list draws. Shared by `list` and `view`. */
const PULL_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "createdAt",
  "updatedAt",
  "headRefName",
  "baseRefName",
  "additions",
  "deletions",
  "changedFiles",
  "reviewDecision",
  "reviewRequests",
];

/**
 * One row of `gh pr list` or `gh pr view` as a pull request.
 *
 * @param viewer The signed-in login: what `authored` and `reviewRequested`
 *   are measured against.
 * @returns null for a row with no number.
 */
function toPull(
  node: Record<string, unknown>,
  viewer: string | null,
): PullRequest | null {
  if (typeof node.number !== "number") return null;
  const author = toAuthor(node.author);
  return {
    number: node.number,
    title: str(node.title) ?? "(untitled)",
    url: str(node.url) ?? "",
    state: toState(str(node.state)),
    author,
    headRef: str(node.headRefName) ?? "",
    baseRef: str(node.baseRefName) ?? "",
    draft: node.isDraft === true,
    additions: num(node.additions),
    deletions: num(node.deletions),
    changedFiles: num(node.changedFiles),
    createdAt: str(node.createdAt) ?? "",
    updatedAt: str(node.updatedAt) ?? "",
    // A team request has no `login`, so only a direct request counts.
    reviewRequested: list(node.reviewRequests).some((item) =>
      same(str(record(item)?.login), viewer),
    ),
    authored: same(author?.login, viewer),
    reviewDecision: str(node.reviewDecision),
  };
}

/** How many pull requests one read brings back. A screen, not an archive. */
const PULLS_PAGE = 50;

/**
 * The `gh pr list` filter for a status.
 *
 * NOTE: `--state closed` includes merged pull requests in `gh`. The search
 * qualifier `is:unmerged` keeps "closed" to what was thrown away, so the
 * two lists never overlap.
 */
function stateArgs(status: PullStatus): string[] {
  if (status === "closed")
    return ["--state", "closed", "--search", "is:unmerged"];
  return ["--state", status];
}

/**
 * One page of a repo's pull requests with a status, most recently updated
 * first.
 *
 * @throws {@link GitHubError} when `gh` fails.
 */
export async function fetchPulls(
  ref: RepoRef,
  status: PullStatus,
  viewer: string | null,
): Promise<PullsView> {
  const rows = await ghJson([
    "pr",
    "list",
    "--repo",
    repoArg(ref),
    ...stateArgs(status),
    "--limit",
    String(PULLS_PAGE),
    "--json",
    PULL_FIELDS.join(","),
  ]);
  const pulls: PullRequest[] = [];
  for (const entry of list(rows)) {
    const node = record(entry);
    const pull = node ? toPull(node, viewer) : null;
    if (pull) pulls.push(pull);
  }
  // `gh pr list` answers newest-created first. The screen reads by activity.
  pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    repo: ref,
    status,
    viewer,
    pulls,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

/** `gh`'s `changeType` words as the file statuses REST uses. */
const CHANGE_TYPES: Record<string, PullFileStatus> = {
  ADDED: "added",
  DELETED: "removed",
  REMOVED: "removed",
  MODIFIED: "modified",
  RENAMED: "renamed",
  COPIED: "copied",
  CHANGED: "changed",
  UNCHANGED: "unchanged",
};

/** One file's slice of a unified diff, keyed for lookup. */
interface DiffPart {
  path: string;
  previousPath: string | null;
  patch: string | null;
}

/** A path from a diff header, with git's C-style quoting undone. */
function diffPath(raw: string, prefix: "a/" | "b/"): string | null {
  let value = raw.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** A patch bigger than this is left out, as GitHub's own file list does. */
const MAX_PATCH_CHARS = 1024 * 1024;

/**
 * Split `gh pr diff` into one patch per file.
 *
 * NOTE: The patch keeps only the hunks, from the first `@@` on. That is the
 * shape GitHub's REST `patch` field has, and what the diff viewer parses.
 * A binary file or a pure rename has no hunks, so its patch is null.
 */
export function splitDiff(diff: string): DiffPart[] {
  const parts: DiffPart[] = [];
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue;
    const lines = section.split("\n");
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let hunk = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        hunk = i;
        break;
      }
      if (line.startsWith("--- ")) oldPath = diffPath(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) newPath = diffPath(line.slice(4), "b/");
      else if (line.startsWith("rename from "))
        renameFrom = diffPath(line.slice(12), "a/");
      else if (line.startsWith("rename to "))
        renameTo = diffPath(line.slice(10), "b/");
    }
    let path = newPath ?? renameTo ?? oldPath;
    if (!path) {
      // No `---`/`+++` (binary, mode-only): `diff --git a/x b/x` names the
      // file twice, so its second half is the path.
      const header = lines[0].slice("diff --git ".length);
      const half = header.length / 2;
      const second = header.slice(Math.ceil(half)).trim();
      path = diffPath(second, "b/");
    }
    if (!path) continue;
    let patch: string | null = null;
    if (hunk > 0) {
      const body = lines.slice(hunk).join("\n").replace(/\n$/, "");
      patch = body.length > MAX_PATCH_CHARS ? null : body;
    }
    const previous =
      renameFrom ?? (oldPath && oldPath !== path ? oldPath : null);
    parts.push({ path, previousPath: previous, patch });
  }
  return parts;
}

/** What one repo allows, read once per detail and merge. */
interface RepoPolicy {
  canMerge: boolean;
  methods: MergeMethod[];
}

/**
 * Whether the viewer may merge in a repo, and by which methods.
 *
 * @returns null when `gh` could not read it.
 */
async function repoPolicy(ref: RepoRef): Promise<RepoPolicy | null> {
  const data = record(
    await ghJson([
      "repo",
      "view",
      repoArg(ref),
      "--json",
      "viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
    ]).catch(() => null),
  );
  if (!data) return null;
  const permission = str(data.viewerPermission);
  const allowed: Record<MergeMethod, unknown> = {
    merge: data.mergeCommitAllowed,
    squash: data.squashMergeAllowed,
    rebase: data.rebaseMergeAllowed,
  };
  return {
    canMerge:
      permission === "ADMIN" ||
      permission === "MAINTAIN" ||
      permission === "WRITE",
    methods: MERGE_METHODS.filter((method) => allowed[method] === true),
  };
}

/** `gh`'s `mergeable`; null while GitHub has not worked it out. */
function toMergeable(raw: string | null): boolean | null {
  if (raw === "MERGEABLE") return true;
  if (raw === "CONFLICTING") return false;
  return null;
}

/** What the merge button needs: mergeability, the viewer's rights, methods. */
function mergeState(
  data: Record<string, unknown>,
  policy: RepoPolicy | null,
): PullMergeState {
  return {
    mergeable: toMergeable(str(data.mergeable)),
    // `mergeStateStatus` uses REST's `mergeable_state` words in upper case.
    state: str(data.mergeStateStatus)?.toLowerCase() ?? null,
    canMerge: policy?.canMerge ?? false,
    methods: policy?.methods ?? [],
  };
}

/** The fields `gh pr view` reads for a pull request's detail. */
const DETAIL_FIELDS = [
  ...PULL_FIELDS,
  "body",
  "files",
  "mergeable",
  "mergeStateStatus",
  "headRefOid",
  "baseRefOid",
];

/**
 * One pull request and its diff.
 *
 * Three reads at once: `gh pr view` for the facts, `gh pr diff` for the
 * hunks and `gh repo view` for merge permissions.
 *
 * NOTE: A failed diff costs the patches, not the screen. GitHub refuses
 * `pr diff` for very large pull requests, and the file list still renders
 * with every patch null.
 *
 * @throws {@link GitHubError} when the pull request cannot be read.
 */
export async function fetchPull(
  ref: RepoRef,
  number: number,
  viewer: string | null,
): Promise<PullDetail> {
  const repo = repoArg(ref);
  const [raw, diff, policy] = await Promise.all([
    ghJson([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      DETAIL_FIELDS.join(","),
    ]),
    gh(["pr", "diff", String(number), "--repo", repo, "--color", "never"], {
      maxBuffer: 64 * 1024 * 1024,
      timeoutMs: 60_000,
    }).catch(() => null),
    repoPolicy(ref),
  ]);
  const data = record(raw);
  const pull = data ? toPull(data, viewer) : null;
  if (!data || !pull)
    throw new GitHubError("failed", "The GitHub CLI returned unreadable data.");
  const headSha = str(data.headRefOid);
  if (!headSha)
    throw new GitHubError(
      "failed",
      "GitHub did not say which commit to diff against.",
    );

  const parts = new Map<string, DiffPart>();
  if (diff !== null)
    for (const part of splitDiff(diff)) parts.set(part.path, part);

  const rows = list(data.files);
  const files: PullFile[] = [];
  for (const entry of rows) {
    const row = record(entry);
    const path = str(row?.path);
    if (!path) continue;
    const part = parts.get(path);
    files.push({
      path,
      previousPath: part?.previousPath ?? null,
      status: CHANGE_TYPES[str(row?.changeType) ?? ""] ?? "modified",
      additions: num(row?.additions),
      deletions: num(row?.deletions),
      patch: part?.patch ?? null,
    });
    if (files.length >= MAX_PULL_FILES) break;
  }

  return {
    repo: ref,
    pull,
    body: str(data.body) ?? "",
    merge: mergeState(data, policy),
    headSha,
    // Empty rather than a throw: only expanding the diff needs the old side.
    baseSha: str(data.baseRefOid) ?? "",
    files,
    truncated: rows.length > files.length || pull.changedFiles > files.length,
    fetchedAt: new Date().toISOString(),
  };
}

/** A menu-sized cap on the commit list. */
const MAX_PULL_COMMITS = 250;

/** Who wrote a commit: a login, else the name in the commit. */
function commitAuthor(entry: Record<string, unknown>): string | null {
  // `authors[0]` is who wrote it. Its `login` is empty for an email GitHub
  // could not match, and the written name is then the only label there is.
  const first = record(list(entry.authors)[0]);
  return str(first?.login) ?? str(first?.name);
}

/**
 * The commits in a pull request, oldest first.
 *
 * GitHub's order, not sorted here: sorting by date would move a rebased or
 * cherry-picked commit to a place its branch never had it.
 *
 * @throws {@link GitHubError} when `gh` fails.
 */
export async function fetchPullCommits(
  ref: RepoRef,
  number: number,
): Promise<PullCommit[]> {
  const data = record(
    await ghJson([
      "pr",
      "view",
      String(number),
      "--repo",
      repoArg(ref),
      "--json",
      "commits",
    ]),
  );
  const commits: PullCommit[] = [];
  for (const entry of list(data?.commits)) {
    const row = record(entry);
    const sha = str(row?.oid);
    if (!row || !sha) continue;
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject: str(row.messageHeadline)?.trim() || "(no message)",
      authorLogin: commitAuthor(row),
      committedAt: str(row.committedDate) ?? "",
    });
  }
  return commits.slice(0, MAX_PULL_COMMITS);
}

/** The file statuses REST may answer with. */
const FILE_STATUS = new Set<PullFileStatus>([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);

/** A file from REST's `files[]`, as `GET /commits/{sha}` returns it. */
function toRestFile(entry: unknown): PullFile | null {
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
    // Absent for binary files and diffs GitHub finds too large.
    patch: str(row?.patch),
  };
}

/**
 * One commit's diff, against its first parent.
 *
 * `gh api` because no `gh` subcommand reads one commit of a repo that may
 * not be cloned here.
 *
 * @throws {@link GitHubError} when `gh` fails or answers unreadable data.
 */
export async function fetchCommitDiff(
  ref: RepoRef,
  sha: string,
): Promise<CommitDiff> {
  const data = record(
    await ghJson(
      [
        "api",
        `repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(sha)}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  if (!data)
    throw new GitHubError("failed", "The GitHub CLI returned unreadable data.");

  const headSha = str(data.sha) ?? sha;
  // NOTE: The FIRST parent. On a merge commit the second parent is the
  // merged branch, and diffing against it would show that whole branch as
  // this commit's work.
  const baseSha = str(record(list(data.parents)[0])?.sha) ?? "";

  const files: PullFile[] = [];
  for (const row of list(data.files)) {
    const file = toRestFile(row);
    if (file) files.push(file);
  }
  return {
    sha: headSha,
    headSha,
    baseSha,
    files: files.slice(0, MAX_PULL_FILES),
    // GitHub caps this response at 300 files and sends no flag for it.
    truncated: files.length >= MAX_PULL_FILES,
  };
}

/**
 * The largest file read whole, in bytes.
 *
 * A bigger file is not worth reading for context lines.
 */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/**
 * One file's contents at a commit, or null.
 *
 * Null for every reason a file cannot be read: absent on this side, too
 * large, refused. The caller is a diff already on screen, and each of those
 * only means the unchanged lines stay folded.
 *
 * @throws {@link GitHubError} for a failure that is not about the file, such
 *   as being signed out.
 */
export async function fetchFileText(
  ref: RepoRef,
  path: string,
  sha: string,
): Promise<FileText | null> {
  const endpoint = `repos/${ref.owner}/${ref.repo}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}?ref=${encodeURIComponent(sha)}`;
  try {
    const text = await gh(
      ["api", endpoint, "-H", "Accept: application/vnd.github.raw"],
      { maxBuffer: MAX_BLOB_BYTES },
    );
    return { text };
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.kind === "not-found" || error.kind === "failed")
    )
      return null;
    throw error;
  }
}

/** The `gh pr review` flag for each verdict. */
const REVIEW_FLAGS: Record<ReviewVerdict, string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

/**
 * Approve, request changes, or comment on a pull request.
 *
 * PR-level only. Line comments need a position model this app does not have.
 *
 * @throws {@link GitHubError} when a comment or a change request is empty,
 *   or `gh` fails.
 */
export async function submitReview(
  ref: RepoRef,
  number: number,
  verdict: ReviewVerdict,
  body: string,
): Promise<void> {
  const text = body.trim();
  // GitHub refuses these two with an empty body. Saying so here is clearer
  // than passing its refusal through.
  if (verdict !== "APPROVE" && !text)
    throw new GitHubError(
      "failed",
      verdict === "COMMENT"
        ? "A comment needs something in it."
        : "Requesting changes needs a note saying what to change.",
    );
  const args = [
    "pr",
    "review",
    String(number),
    "--repo",
    repoArg(ref),
    REVIEW_FLAGS[verdict],
  ];
  if (text) args.push("--body-file", "-");
  await gh(args, text ? { input: text } : {});
}

/**
 * Merge a pull request at the head commit the user reviewed.
 *
 * NOTE: `--match-head-commit` is what makes "merge what I reviewed" true.
 * Without it a push that landed after the screen loaded would be merged
 * unseen.
 *
 * @throws {@link GitHubError} when the pull request is not open, is a draft,
 *   has a new head, conflicts, or the viewer or repo does not allow the
 *   merge.
 */
export async function mergePull(
  ref: RepoRef,
  number: number,
  method: MergeMethod,
  headSha: string,
): Promise<void> {
  if (!MERGE_METHODS.includes(method) || !/^[0-9a-f]{40,64}$/i.test(headSha))
    throw new GitHubError(
      "failed",
      "A valid merge method and full head commit are required.",
    );
  const repo = repoArg(ref);
  const [raw, policy] = await Promise.all([
    ghJson([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,isDraft,headRefOid,mergeable,mergeStateStatus",
    ]),
    repoPolicy(ref),
  ]);
  const pull = record(raw);
  if (!pull)
    throw new GitHubError("failed", "The GitHub CLI returned unreadable data.");
  if (str(pull.state) !== "OPEN")
    throw new GitHubError(
      "conflict",
      "This pull request is no longer open. Refresh it.",
    );
  if (pull.isDraft === true)
    throw new GitHubError(
      "conflict",
      "Mark this pull request ready for review before merging.",
    );
  if (!same(str(pull.headRefOid), headSha))
    throw new GitHubError(
      "conflict",
      "The head commit changed. Refresh and review the new changes before merging.",
    );
  if (policy && !policy.canMerge)
    throw new GitHubError(
      "forbidden",
      "Write access to this repository is required to merge.",
    );
  if (policy && !policy.methods.includes(method))
    throw new GitHubError(
      "failed",
      "This merge method is disabled in the repository settings.",
    );
  if (toMergeable(str(pull.mergeable)) === false)
    throw new GitHubError(
      "conflict",
      "Resolve the merge conflicts before merging.",
    );

  await gh(
    [
      "pr",
      "merge",
      String(number),
      "--repo",
      repo,
      `--${method}`,
      "--match-head-commit",
      headSha,
    ],
    { timeoutMs: 60_000 },
  );
}

/** GitHub's check vocabularies, narrowed to the four a reviewer acts on. */
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
    case "EXPECTED":
      return "pending";
    default:
      // ACTION_REQUIRED, CANCELLED, NEUTRAL, SKIPPED, STALE: not a pass, not
      // a failure, and no longer running.
      return "neutral";
  }
}

/**
 * The checks on the head commit, from `statusCheckRollup`.
 *
 * - `gh` gives no check ids, so one is made from the position and name.
 *   It only has to be unique within this list.
 * - `gh` gives no overall state either. It is computed the way GitHub's
 *   rollup reads: any failure fails, then anything running is pending.
 */
function toChecks(rollup: unknown): PullChecks {
  const nodes = list(rollup);
  // No contexts at all means NO CHECKS, not a failed read.
  if (!nodes.length) return { state: null, checks: [], truncated: false };

  const checks: PullCheck[] = [];
  nodes.forEach((raw, index) => {
    const node = record(raw);
    if (!node) return;
    if (node.__typename === "StatusContext") {
      const name = str(node.context) ?? "Status";
      checks.push({
        id: `status:${index}:${name}`,
        name,
        state: toCheckState(str(node.state)),
        url: str(node.targetUrl),
      });
      return;
    }
    // A run that has not finished has no conclusion yet; `status` says it
    // is still going.
    const name = str(node.name) ?? "Check";
    checks.push({
      id: `check:${index}:${name}`,
      name,
      state: toCheckState(str(node.conclusion) ?? str(node.status)),
      url: str(node.detailsUrl),
    });
  });

  const states = new Set(checks.map((check) => check.state));
  const state: CheckState = states.has("failure")
    ? "failure"
    : states.has("pending")
      ? "pending"
      : states.has("success")
        ? "success"
        : "neutral";
  return {
    state,
    checks: checks.slice(0, MAX_PULL_CHECKS),
    truncated: checks.length > MAX_PULL_CHECKS,
  };
}

/**
 * A pull request's timeline and CI, from one `gh pr view`.
 *
 * - `gh` has no timeline field, so the timeline is built from `comments`,
 *   `reviews` and `commits`, ordered by time. Label, rename and
 *   review-request events are not available, and the screen does not draw
 *   them.
 * - "Opened" is made from the pull request's own `createdAt`.
 * - A run of commits folds into one `N commits` entry.
 *
 * @throws {@link GitHubError} when the pull request cannot be read.
 */
export async function fetchPullActivity(
  ref: RepoRef,
  number: number,
): Promise<PullActivity> {
  const pull = record(
    await ghJson([
      "pr",
      "view",
      String(number),
      "--repo",
      repoArg(ref),
      "--json",
      "author,createdAt,comments,reviews,commits,statusCheckRollup",
    ]),
  );
  if (!pull)
    throw new GitHubError("not-found", "That pull request no longer exists.");

  type Event =
    | { kind: "comment" | "review"; item: PullTimelineItem }
    | { kind: "commit"; id: string; actor: string | null; at: string };
  const events: Event[] = [];

  for (const entry of list(pull.comments)) {
    const row = record(entry);
    const id = str(row?.id);
    if (!row || !id) continue;
    events.push({
      kind: "comment",
      item: {
        kind: "comment",
        id,
        actor: str(record(row.author)?.login),
        at: str(row.createdAt) ?? "",
        body: str(row.body) ?? "",
      },
    });
  }
  for (const entry of list(pull.reviews)) {
    const row = record(entry);
    const id = str(row?.id);
    // A review still being written is the reviewer's draft, not an event.
    if (!row || !id || str(row.state) === "PENDING") continue;
    events.push({
      kind: "review",
      item: {
        kind: "review",
        id,
        actor: str(record(row.author)?.login),
        at: str(row.submittedAt) ?? "",
        verdict: str(row.state),
        body: str(row.body) ?? "",
      },
    });
  }
  for (const entry of list(pull.commits)) {
    const row = record(entry);
    const id = str(row?.oid);
    if (!row || !id) continue;
    events.push({
      kind: "commit",
      id,
      actor: commitAuthor(row),
      at: str(row.committedDate) ?? "",
    });
  }

  const at = (event: Event) =>
    event.kind === "commit" ? event.at : event.item.at;
  // Stable sort: equal times keep GitHub's own order.
  events.sort((a, b) => at(a).localeCompare(at(b)));

  const items: PullTimelineItem[] = [];
  for (const event of events) {
    if (event.kind !== "commit") {
      items.push(event.item);
      continue;
    }
    const last = items[items.length - 1];
    if (last?.kind === "commits") {
      last.count += 1;
      last.at = event.at || last.at;
      continue;
    }
    items.push({
      kind: "commits",
      id: event.id,
      actor: event.actor,
      at: event.at,
      count: 1,
    });
  }

  // The LAST entries: a long-running pull request's interesting end is the
  // recent one.
  const kept = items.slice(-MAX_TIMELINE_ITEMS);
  return {
    number,
    items: [
      {
        kind: "opened",
        id: `opened-${number}`,
        actor: str(record(pull.author)?.login),
        at: str(pull.createdAt) ?? new Date().toISOString(),
      },
      ...kept,
    ],
    truncated: items.length > kept.length,
    checks: toChecks(pull.statusCheckRollup),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Leave an ordinary comment on a pull request.
 *
 * Not {@link submitReview}: a review carries a verdict that can block a
 * merge, and a comment never does.
 *
 * @throws {@link GitHubError} when the comment is empty or `gh` fails.
 */
export async function addComment(
  ref: RepoRef,
  number: number,
  body: string,
): Promise<void> {
  const text = body.trim();
  if (!text)
    throw new GitHubError("failed", "A comment needs something in it.");
  await gh(
    [
      "pr",
      "comment",
      String(number),
      "--repo",
      repoArg(ref),
      "--body-file",
      "-",
    ],
    { input: text },
  );
}
