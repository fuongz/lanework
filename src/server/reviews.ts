import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/auth";
import {
  listRepos,
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

/** Current signed-in user (or null). Safe to call when logged out. */
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
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

/** Repos the signed-in user can access. */
export const getRepos = createServerFn({ method: "GET" }).handler(async (): Promise<Repo[]> => {
  const { token } = await requireGitHubToken();
  return listRepos(token);
});

/**
 * GitHub page where the user can grant this OAuth app access to their
 * organizations' repos (the client id is public, not a secret).
 */
export const getGithubManageUrl = createServerFn({ method: "GET" }).handler(async () => {
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

const boardValidator = (d: unknown): { owner: string; repo: string } => {
  const v = d as { owner?: string; repo?: string };
  return { owner: safeName(v?.owner, "owner"), repo: safeName(v?.repo, "repo") };
};

export interface BoardData {
  owner: string;
  repo: string;
  branch: string;
  viewer: string; // GitHub login of the signed-in user (for "My tasks")
  cards: ReviewCard[];
}

// Short-lived per-user cache. Keyed by user id so cached repo content is never
// served to a different user (who may not have access to that repo).
const BOARD_TTL_SECONDS = 60;
type CachedBoard = { branch: string; viewer: string; cards: ReviewCard[] };

/** All review cards for a repo, grouped client-side into columns. */
export const getBoard = createServerFn({ method: "GET" })
  .validator(boardValidator)
  .handler(async ({ data }): Promise<BoardData> => {
    const { token, userId } = await requireGitHubToken();
    const cache = env.CACHE as KVNamespace | undefined;
    const cacheKey = `board:${userId}:${data.owner}/${data.repo}`;

    if (cache) {
      const hit = await cache.get<CachedBoard>(cacheKey, "json").catch(() => null);
      if (hit) return { owner: data.owner, repo: data.repo, ...hit };
    }

    const [{ branch, cards }, viewer] = await Promise.all([
      listReviewCards(token, data.owner, data.repo),
      getViewerLogin(token),
    ]);
    const payload: CachedBoard = { branch, viewer, cards };

    if (cache) {
      await cache
        .put(cacheKey, JSON.stringify(payload), { expirationTtl: BOARD_TTL_SECONDS })
        .catch(() => {});
    }
    return { owner: data.owner, repo: data.repo, ...payload };
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
    const { token } = await requireGitHubToken();
    return getReviewContent(token, data.owner, data.repo, data.path, data.ref);
  });
