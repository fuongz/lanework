import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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
async function requireGitHubToken(): Promise<{ token: string; userName: string }> {
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

  return { token, userName: session.user.name };
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

const boardValidator = (d: unknown): { owner: string; repo: string } => {
  const v = d as { owner?: string; repo?: string };
  if (!v?.owner || !v?.repo) throw new Error("owner and repo are required");
  return { owner: v.owner, repo: v.repo };
};

export interface BoardData {
  owner: string;
  repo: string;
  branch: string;
  viewer: string; // GitHub login of the signed-in user (for "My tasks")
  cards: ReviewCard[];
}

/** All review cards for a repo, grouped client-side into columns. */
export const getBoard = createServerFn({ method: "GET" })
  .validator(boardValidator)
  .handler(async ({ data }): Promise<BoardData> => {
    const { token } = await requireGitHubToken();
    const [{ branch, cards }, viewer] = await Promise.all([
      listReviewCards(token, data.owner, data.repo),
      getViewerLogin(token),
    ]);
    return { owner: data.owner, repo: data.repo, branch, viewer, cards };
  });

const contentValidator = (d: unknown): { owner: string; repo: string; path: string; ref?: string } => {
  const v = d as { owner?: string; repo?: string; path?: string; ref?: string };
  if (!v?.owner || !v?.repo || !v?.path) throw new Error("owner, repo and path are required");
  if (!v.path.startsWith(".agents/reviews/")) throw new Error("path outside reviews folder");
  return { owner: v.owner, repo: v.repo, path: v.path, ref: v.ref };
};

/** Markdown content of a single review card, fetched on demand. */
export const getCardContent = createServerFn({ method: "GET" })
  .validator(contentValidator)
  .handler(async ({ data }): Promise<string> => {
    const { token } = await requireGitHubToken();
    return getReviewContent(token, data.owner, data.repo, data.path, data.ref);
  });
