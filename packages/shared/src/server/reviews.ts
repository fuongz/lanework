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
    // `CACHE` (KV) is commented out in wrangler.jsonc while the hosted webapp is
    // paused, so it's absent from the generated `Env` type. Hosted-only path; cast
    // so it typechecks and degrades to "no cache" when the binding isn't bound.
    const cache = (env as unknown as { CACHE?: KVNamespace }).CACHE;
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

const saveValidator = (d: unknown): { owner: string; repo: string; path: string; content: string } => {
  const v = d as { owner?: string; repo?: string; path?: string; content?: string };
  const owner = safeName(v?.owner, "owner");
  const repo = safeName(v?.repo, "repo");
  if (typeof v?.path !== "string") throw new Error("path is required");
  if (!v.path.startsWith(".agents/reviews/") || v.path.includes("..") || !v.path.endsWith(".md")) {
    throw new Error("path outside reviews folder");
  }
  if (typeof v?.content !== "string") throw new Error("content is required");
  return { owner, repo, path: v.path, content: v.content };
};

/**
 * Persist edited review markdown back to disk. Only supported in local mode
 * (`lanework`), where the board is the repo's own working tree; the cloud build
 * has no write path to GitHub, so it rejects.
 */
export const saveCardContent = createServerFn({ method: "POST" })
  .validator(saveValidator)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    if (__LANEWORK_LOCAL__) {
      const { saveLocalCardContent } = await import("@/lib/local-fs");
      await saveLocalCardContent(data.path, data.content);
      return { ok: true };
    }
    throw new Error("Saving is only available in local mode.");
  });

const REVIEW_STATUSES = ["todo", "processing", "done", "dropped"] as const;

const statusValidator = (d: unknown): { owner: string; repo: string; path: string; status: string } => {
  const v = d as { owner?: string; repo?: string; path?: string; status?: string };
  const owner = safeName(v?.owner, "owner");
  const repo = safeName(v?.repo, "repo");
  if (typeof v?.path !== "string") throw new Error("path is required");
  if (!v.path.startsWith(".agents/reviews/") || v.path.includes("..") || !v.path.endsWith(".md")) {
    throw new Error("path outside reviews folder");
  }
  if (typeof v?.status !== "string" || !(REVIEW_STATUSES as readonly string[]).includes(v.status)) {
    throw new Error("invalid status");
  }
  return { owner, repo, path: v.path, status: v.status };
};

/**
 * Move a review card to a new column by rewriting its `status:` frontmatter (or
 * relocating the file in folder mode). Drives drag-and-drop on the board. Local
 * mode only — the cloud build has no write path to GitHub. Returns the (possibly
 * relocated) path so the caller can follow the card.
 */
export const setCardStatus = createServerFn({ method: "POST" })
  .validator(statusValidator)
  .handler(async ({ data }): Promise<{ path: string; status: string; moved: boolean }> => {
    if (__LANEWORK_LOCAL__) {
      const { setLocalReviewStatus } = await import("@/lib/local-fs");
      return setLocalReviewStatus(data.path, data.status);
    }
    throw new Error("Changing status is only available in local mode.");
  });

const PRIORITIES = ["low", "medium", "high"] as const;

const createValidator = (
  d: unknown,
): { owner: string; repo: string; title: string; assignees: string[]; priority?: string; status: string } => {
  const v = d as {
    owner?: string;
    repo?: string;
    title?: string;
    assignees?: unknown;
    priority?: string;
    status?: string;
  };
  const owner = safeName(v?.owner, "owner");
  const repo = safeName(v?.repo, "repo");
  const title = typeof v?.title === "string" ? v.title.trim() : "";
  if (!title) throw new Error("title is required");
  if (title.length > 200) throw new Error("title too long");
  const assignees = Array.isArray(v?.assignees)
    ? v.assignees.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
    : [];
  const status =
    typeof v?.status === "string" && (REVIEW_STATUSES as readonly string[]).includes(v.status) ? v.status : "todo";
  const priority =
    typeof v?.priority === "string" && (PRIORITIES as readonly string[]).includes(v.priority) ? v.priority : undefined;
  return { owner, repo, title, assignees, priority, status };
};

/**
 * Create a brand-new review card (the "Add" action on the board). Local mode only
 * — the cloud build has no write path to GitHub. Returns the new card's path so the
 * caller can immediately dispatch a planning agent at it.
 */
export const createCard = createServerFn({ method: "POST" })
  .validator(createValidator)
  .handler(async ({ data }): Promise<{ path: string; status: string }> => {
    if (__LANEWORK_LOCAL__) {
      const { createLocalReview } = await import("@/lib/local-fs");
      const res = await createLocalReview({
        title: data.title,
        status: data.status,
        assignees: data.assignees,
        priority: data.priority as "low" | "medium" | "high" | undefined,
      });
      return { path: res.path, status: res.status };
    }
    throw new Error("Creating cards is only available in local mode.");
  });

/**
 * Aggregate token usage from this project's Claude Code transcripts
 * (`~/.claude/projects/<…>`) so the board can estimate cost. Local mode only —
 * the cloud build can't read the user's home directory.
 */
export const getCostEstimate = createServerFn({ method: "GET" }).handler(
  async (): Promise<import("@/lib/local-fs").CostData> => {
    if (__LANEWORK_LOCAL__) {
      const { getLocalCostEstimate } = await import("@/lib/local-fs");
      return getLocalCostEstimate();
    }
    return { available: false, projectDir: "", sessions: 0, models: [], firstAt: null, lastAt: null };
  },
);

const pathOnlyValidator = (d: unknown): { owner: string; repo: string; path: string } => {
  const v = d as { owner?: string; repo?: string; path?: string };
  const owner = safeName(v?.owner, "owner");
  const repo = safeName(v?.repo, "repo");
  if (typeof v?.path !== "string") throw new Error("path is required");
  if (!v.path.startsWith(".agents/reviews/") || v.path.includes("..") || !v.path.endsWith(".md")) {
    throw new Error("path outside reviews folder");
  }
  return { owner, repo, path: v.path };
};

/** Delete a review card's file. Local mode only — the cloud build is read-only. */
export const deleteCard = createServerFn({ method: "POST" })
  .validator(pathOnlyValidator)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    if (__LANEWORK_LOCAL__) {
      const { deleteLocalReview } = await import("@/lib/local-fs");
      return deleteLocalReview(data.path);
    }
    throw new Error("Deleting is only available in local mode.");
  });

/** Current git branch of the local checkout (null in hosted mode). */
export const getLocalBranch = createServerFn({ method: "GET" }).handler(async (): Promise<string | null> => {
  if (__LANEWORK_LOCAL__) {
    const { localGitBranch } = await import("@/lib/local-fs");
    return localGitBranch();
  }
  return null;
});
