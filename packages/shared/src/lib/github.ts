// Thin GitHub REST/GraphQL client using fetch (no SDK) so it bundles cleanly on Workers.
import {
  REVIEW_ROOT,
  BOARD_CONFIG_PATH,
  buildReviewCard,
  parseBoardConfig,
  resolveCardLocation,
  type ReviewCard,
} from "./reviews-core";

// Re-export the shared review types/constants so existing importers of this
// module (UI, server fns) keep working unchanged.
export { REVIEW_ROOT, REVIEW_COLUMNS } from "./reviews-core";
export type { ReviewColumn, Priority, ReviewCard, LastRun } from "./reviews-core";

const GH_API = "https://api.github.com";
const GH_GRAPHQL = "https://api.github.com/graphql";

export interface Repo {
  id: number;
  fullName: string; // owner/repo
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  homepage: string | null; // repo's website, if set
  defaultBranch: string;
  updatedAt: string;
}

export class GitHubError extends Error {
  /** Raw response body, kept for server-side logging — never shown to users. */
  detail?: string;
  constructor(public status: number, detail?: string) {
    super(messageForStatus(status));
    this.name = "GitHubError";
    this.detail = detail;
  }
}

/** Short, user-facing message for a failed GitHub request. */
function messageForStatus(status: number): string {
  switch (status) {
    case 401:
      return "Your session expired — please sign in again.";
    case 403:
      return "You don't have access to this resource.";
    case 404:
      return "This review could not be found.";
    default:
      return `GitHub request failed (${status}).`;
  }
}

function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lanework",
  };
}

async function ghFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new GitHubError(res.status, `GitHub ${res.status} on ${path}: ${body.slice(0, 200)}`);
    console.error(err.detail);
    throw err;
  }
  return (await res.json()) as T;
}

/** Login of the authenticated user (used to filter "My tasks"). */
export async function getViewerLogin(token: string): Promise<string> {
  const u = await ghFetch<{ login: string }>(token, "/user");
  return u.login;
}

const REPO_AFFILIATION = "owner,collaborator,organization_member";

function mapRepo(r: any): Repo {
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    description: r.description,
    homepage: r.homepage || null,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  };
}

/** Repos the authenticated user can access, most recently updated first (full list). */
export async function listRepos(token: string): Promise<Repo[]> {
  const raw = await ghFetch<any[]>(
    token,
    `/user/repos?per_page=100&sort=updated&affiliation=${REPO_AFFILIATION}`,
  );
  return raw.map(mapRepo);
}

/** Branch names for a repo (up to 100), default branch first. */
export async function listBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const [raw, meta] = await Promise.all([
    ghFetch<{ name: string }[]>(token, `/repos/${o}/${r}/branches?per_page=100`),
    ghFetch<{ default_branch: string }>(token, `/repos/${o}/${r}`).catch(() => null),
  ]);
  const names = raw.map((b) => b.name);
  const def = meta?.default_branch;
  // Surface the default branch first; keep the rest in GitHub's order.
  return def && names.includes(def) ? [def, ...names.filter((n) => n !== def)] : names;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

/**
 * List every review card under `.agents/reviews/`, enriched with the frontmatter
 * metadata + checklist stats parsed from each file's content. Content is
 * batch-fetched via GraphQL (≈50 files per request). The optional
 * `.agents/reviews/config.json` selects how each card's column is derived
 * (folder vs. frontmatter `status:`); see `resolveCardLocation`.
 */
export async function listReviewCards(
  token: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<{ branch: string; cards: ReviewCard[] }> {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const branch =
    ref ?? (await ghFetch<{ default_branch: string }>(token, `/repos/${o}/${r}`)).default_branch;

  const tree = await ghFetch<{ tree: TreeEntry[] }>(
    token,
    `/repos/${o}/${r}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  const mdEntries = tree.tree.filter(
    (e) => e.type === "blob" && e.path.endsWith(".md") && e.path.startsWith(`${REVIEW_ROOT}/`),
  );
  const hasConfig = tree.tree.some((e) => e.type === "blob" && e.path === BOARD_CONFIG_PATH);

  // One batched fetch for every review file plus the config (frontmatter mode
  // needs each file's content to read its `status:` field).
  const paths = mdEntries.map((e) => e.path);
  if (hasConfig) paths.push(BOARD_CONFIG_PATH);
  const blobs = await fetchBlobs(token, owner, repo, branch, paths);
  const config = parseBoardConfig(hasConfig ? blobs.get(BOARD_CONFIG_PATH) : undefined);

  const cards: ReviewCard[] = [];
  for (const entry of mdEntries) {
    const text = blobs.get(entry.path);
    const segments = entry.path.slice(REVIEW_ROOT.length + 1).split("/");
    const loc = resolveCardLocation(segments, config, text);
    if (!loc) continue; // not a board file (e.g. a stray .md outside any column)
    cards.push(
      buildReviewCard({
        path: entry.path,
        column: loc.column,
        fileName: loc.fileName,
        sha: entry.sha,
        text,
        folderDate: loc.folderDate,
        config,
      }),
    );
  }

  return { branch, cards };
}

/** Decoded markdown content of a single review file (for the detail drawer). */
export async function getReviewContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const data = await ghFetch<{ content: string; encoding: string }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${q}`,
  );
  if (data.encoding === "base64") {
    const binary = atob(data.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  return data.content;
}

/** Batch-fetch blob texts by path via GraphQL aliases, chunked to stay small. */
async function fetchBlobs(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 50) {
    const chunk = paths.slice(i, i + 50);
    const fields = chunk
      .map((p, j) => `b${j}: object(expression: ${JSON.stringify(`${branch}:${p}`)}) { ... on Blob { text } }`)
      .join("\n");
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${fields} } }`;
    const res = await fetch(GH_GRAPHQL, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) continue;
    const json = (await res.json()) as { data?: { repository?: Record<string, { text?: string } | null> } };
    const repoObj = json.data?.repository;
    if (!repoObj) continue;
    chunk.forEach((p, j) => {
      const blob = repoObj[`b${j}`];
      if (blob && typeof blob.text === "string") out.set(p, blob.text);
    });
  }
  return out;
}

