// Thin GitHub REST/GraphQL client using fetch (no SDK) so it bundles cleanly on Workers.
import { parseReviewStats, type ReviewStats } from "./review-stats";

const GH_API = "https://api.github.com";
const GH_GRAPHQL = "https://api.github.com/graphql";

export const REVIEW_ROOT = ".agents/reviews";
export const REVIEW_COLUMNS = ["todo", "processing", "done", "dropped"] as const;
export type ReviewColumn = (typeof REVIEW_COLUMNS)[number];
export type Priority = "low" | "medium" | "high";

export interface Repo {
  id: number;
  fullName: string; // owner/repo
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string;
}

export interface ReviewCard {
  path: string; // full repo path, e.g. .agents/reviews/todo/2026-06-21-foo.md
  column: ReviewColumn;
  fileName: string; // 2026-06-21-foo.md
  date: string | null; // created_at frontmatter date, else date in filename
  title: string; // humanized slug
  sha: string;
  assignees: string[];
  tags: string[];
  priority: Priority | null;
  stats: ReviewStats;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GitHubError";
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
    throw new GitHubError(res.status, `GitHub ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Login of the authenticated user (used to filter "My tasks"). */
export async function getViewerLogin(token: string): Promise<string> {
  const u = await ghFetch<{ login: string }>(token, "/user");
  return u.login;
}

/** Repos the authenticated user can access, most recently updated first. */
export async function listRepos(token: string): Promise<Repo[]> {
  const raw = await ghFetch<any[]>(
    token,
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
  );
  return raw.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

/**
 * List every review card under `.agents/reviews/<column>/`, enriched with the
 * frontmatter metadata + checklist stats parsed from each file's content.
 * Content is batch-fetched via GraphQL (≈50 files per request).
 */
export async function listReviewCards(
  token: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<{ branch: string; cards: ReviewCard[] }> {
  const branch =
    ref ?? (await ghFetch<{ default_branch: string }>(token, `/repos/${owner}/${repo}`)).default_branch;

  const tree = await ghFetch<{ tree: TreeEntry[] }>(
    token,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  const entries = tree.tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md") && e.path.startsWith(`${REVIEW_ROOT}/`))
    .map((e) => {
      const rest = e.path.slice(REVIEW_ROOT.length + 1); // <column>/<file>.md
      const [column, ...fileParts] = rest.split("/");
      return { entry: e, column, fileName: fileParts[0], ok: isReviewColumn(column) && fileParts.length === 1 };
    })
    .filter((x) => x.ok);

  const blobs = await fetchBlobs(token, owner, repo, branch, entries.map((e) => e.entry.path));

  const cards: ReviewCard[] = entries.map(({ entry, column, fileName }) => {
    const text = blobs.get(entry.path);
    const meta = text ? parseFrontmatter(text) : EMPTY_META;
    const stats = text ? parseReviewStats(text) : { total: 0, done: 0, notes: 0 };
    return {
      path: entry.path,
      column: column as ReviewColumn,
      fileName,
      date: meta.createdAt ?? extractDate(fileName),
      title: humanizeFileName(fileName),
      sha: entry.sha,
      assignees: meta.assignees,
      tags: meta.tags,
      priority: meta.priority,
      stats,
    };
  });

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
    `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`,
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

interface ReviewMeta {
  assignees: string[];
  tags: string[];
  priority: Priority | null;
  createdAt: string | null;
}
const EMPTY_META: ReviewMeta = { assignees: [], tags: [], priority: null, createdAt: null };

/** Parse the simple YAML frontmatter block at the top of a review file. */
function parseFrontmatter(md: string): ReviewMeta {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return EMPTY_META;
  const meta: ReviewMeta = { assignees: [], tags: [], priority: null, createdAt: null };
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "assignees") meta.assignees = parseList(val);
    else if (key === "tags") meta.tags = parseList(val);
    else if (key === "priority") meta.priority = normPriority(val);
    else if (key === "created_at") meta.createdAt = extractDate(val);
  }
  return meta;
}

function parseList(v: string): string[] {
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to lenient parsing */
  }
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normPriority(v: string): Priority | null {
  const s = v.replace(/['"]/g, "").toLowerCase().trim();
  return s === "low" || s === "medium" || s === "high" ? s : null;
}

function isReviewColumn(c: string): c is ReviewColumn {
  return (REVIEW_COLUMNS as readonly string[]).includes(c);
}

function extractDate(s: string): string | null {
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function humanizeFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.md$/, "");
  const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const words = withoutDate.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
