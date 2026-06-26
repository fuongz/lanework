import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/auth";
import {
  listRepos,
  listBranches,
  listReviewCards,
  getReviewContent,
  getViewerLogin,
  type Repo,
  type ReviewCard,
} from "@/lib/github";

/** Resolve the current session + a fresh GitHub access token, or throw 401. */
async function requireGitHubToken(): Promise<{ token: string; userId: string }> {
  const auth = getAuth();
  const { headers } = getRequest();

  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const tokenResult = await auth.api.getAccessToken({
    body: { providerId: "github" },
    headers,
  });
  const token = (tokenResult as { accessToken?: string })?.accessToken;
  if (!token) {
    throw new Response("No GitHub access token; please sign in again.", { status: 401 });
  }

  return { token, userId: session.user.id };
}

// In local mode there's no auth: the board is the local repo's own
// `.agents/reviews` folder, so we return a synthetic always-signed-in user and
// read everything off disk. `__LANEWORK_LOCAL__` is a build-time constant, so
// the Cloudflare bundle drops these branches (and the node:* deps) entirely.
const LOCAL_VIEWER = "local";

/** Current signed-in user (or null). Safe to call when logged out. */
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  if (__LANEWORK_LOCAL__) {
    const { localRepoName } = await import("@/lib/local-fs");
    return { id: LOCAL_VIEWER, name: localRepoName(), email: "", image: null };
  }
  const auth = getAuth();
  const { headers } = getRequest();
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    image: session.user.image ?? null,
  };
});

/**
 * Full list of repos the user can access (up to 100). Fetched once and cached
 * client-side, then paginated (listing) and searched (switcher) in-memory.
 */
export const getAllRepos = createServerFn({ method: "GET" }).handler(async (): Promise<Repo[]> => {
  if (__LANEWORK_LOCAL__) {
    const { localRepoName } = await import("@/lib/local-fs");
    const name = localRepoName();
    // A single synthetic repo representing the local working directory.
    return [
      {
        id: 0,
        fullName: `${LOCAL_VIEWER}/${name}`,
        owner: LOCAL_VIEWER,
        name,
        private: true,
        description: null,
        homepage: null,
        defaultBranch: "local",
        updatedAt: new Date().toISOString(),
      },
    ];
  }
  const { token } = await requireGitHubToken();
  return listRepos(token);
});

/**
 * GitHub page where the user can grant this OAuth app access to their
 * organizations' repos (the client id is public, not a secret).
 */
export const getGithubManageUrl = createServerFn({ method: "GET" }).handler(async () => {
  if (__LANEWORK_LOCAL__) return null; // no GitHub OAuth app in local mode
  const auth = getAuth();
  const { headers } = getRequest();
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return `https://github.com/settings/connections/applications/${env.GITHUB_CLIENT_ID}`;
});

// GitHub owner/repo names: letters, digits, dot, dash, underscore — no slashes
// or `..` (which would let a crafted value escape the intended API path).
const NAME_RE = /^[A-Za-z0-9._-]+$/;
function safeName(value: unknown, field: string): string {
  if (typeof value !== "string" || !NAME_RE.test(value) || value.includes("..")) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

// A git ref (branch) may contain slashes (e.g. `feature/x`), so it's more permissive
// than a repo name — but still reject traversal and whitespace.
function safeRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.includes("..") || /\s/.test(value)) {
    throw new Error("invalid branch");
  }
  return value;
}

const boardValidator = (
  d: unknown,
): { owner: string; repo: string; branch?: string; refresh: boolean } => {
  const v = d as { owner?: string; repo?: string; branch?: string; refresh?: unknown };
  return {
    owner: safeName(v?.owner, "owner"),
    repo: safeName(v?.repo, "repo"),
    branch: safeRef(v?.branch),
    // When true, bypass the KV cache and force a fresh GitHub fetch.
    refresh: v?.refresh === true,
  };
};

const branchesValidator = (d: unknown): { owner: string; repo: string } => {
  const v = d as { owner?: string; repo?: string };
  return { owner: safeName(v?.owner, "owner"), repo: safeName(v?.repo, "repo") };
};

/** Branch names for a repo (default branch first). */
export const getBranches = createServerFn({ method: "GET" })
  .validator(branchesValidator)
  .handler(async ({ data }): Promise<string[]> => {
    if (__LANEWORK_LOCAL__) return ["local"]; // single pseudo-branch (the working tree)
    const { token } = await requireGitHubToken();
    return listBranches(token, data.owner, data.repo);
  });

export interface BoardData {
  owner: string;
  repo: string;
  branch: string;
  viewer: string; // GitHub login of the signed-in user (for "My tasks")
  cards: ReviewCard[];
  fetchedAt: number; // epoch ms the cards were fetched from GitHub
  cached: boolean; // whether this response was served from KV
}

// Per-user cache for the (slow) GitHub board fetch. Keyed by user id so cached
// repo content is never served to a different user (who may not have access to
// that repo). The TTL is the freshness bound; users can force-refresh sooner.
const BOARD_TTL_SECONDS = 600; // 10 minutes
type CachedBoard = {
  branch: string;
  viewer: string;
  cards: ReviewCard[];
  fetchedAt: number;
};

/** All review cards for a repo, grouped client-side into columns. */
export const getBoard = createServerFn({ method: "GET" })
  .validator(boardValidator)
  .handler(async ({ data }): Promise<BoardData> => {
    if (__LANEWORK_LOCAL__) {
      const { listLocalReviewCards } = await import("@/lib/local-fs");
      const cards = await listLocalReviewCards();
      return {
        owner: data.owner,
        repo: data.repo,
        branch: "local",
        viewer: LOCAL_VIEWER,
        cards,
        fetchedAt: Date.now(),
        cached: false,
      };
    }
    const { token, userId } = await requireGitHubToken();
    const cache = env.CACHE as KVNamespace | undefined;
    const cacheKey = `board:${userId}:${data.owner}/${data.repo}@${data.branch ?? "default"}`;

    if (cache && !data.refresh) {
      const hit = await cache.get<CachedBoard>(cacheKey, "json").catch(() => null);
      if (hit) return { owner: data.owner, repo: data.repo, cached: true, ...hit };
    }

    const [{ branch, cards }, viewer] = await Promise.all([
      listReviewCards(token, data.owner, data.repo, data.branch),
      getViewerLogin(token),
    ]);
    const payload: CachedBoard = { branch, viewer, cards, fetchedAt: Date.now() };

    if (cache) {
      await cache
        .put(cacheKey, JSON.stringify(payload), { expirationTtl: BOARD_TTL_SECONDS })
        .catch(() => {});
    }
    return { owner: data.owner, repo: data.repo, cached: false, ...payload };
  });

const contentValidator = (d: unknown): { owner: string; repo: string; path: string; ref?: string } => {
  const v = d as { owner?: string; repo?: string; path?: string; ref?: string };
  const owner = safeName(v?.owner, "owner");
  const repo = safeName(v?.repo, "repo");
  if (typeof v?.path !== "string") throw new Error("path is required");
  // Restrict reads to review markdown; reject traversal out of the folder.
  if (!v.path.startsWith(".agents/reviews/") || v.path.includes("..") || !v.path.endsWith(".md")) {
    throw new Error("path outside reviews folder");
  }
  if (v.ref !== undefined && (typeof v.ref !== "string" || v.ref.includes("..") || /\s/.test(v.ref))) {
    throw new Error("invalid ref");
  }
  return { owner, repo, path: v.path, ref: v.ref };
};

/** Markdown content of a single review card, fetched on demand. */
export const getCardContent = createServerFn({ method: "GET" })
  .validator(contentValidator)
  .handler(async ({ data }): Promise<string> => {
    if (__LANEWORK_LOCAL__) {
      const { getLocalCardContent } = await import("@/lib/local-fs");
      return getLocalCardContent(data.path);
    }
    const { token } = await requireGitHubToken();
    return getReviewContent(token, data.owner, data.repo, data.path, data.ref);
  });
