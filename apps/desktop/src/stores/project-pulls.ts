import { useEffect } from "react";
import { create } from "zustand";
import {
  type PullChecks,
  type PullRef,
  type PullRequest,
  type RepoRef,
  sameRepo,
  selectedRepo,
} from "#/../shared/git";
import { desktopSurface } from "#/server/desktop";

/**
 * A project's pull requests for the chat and the session details (FE-174),
 * kept apart from `usePulls`: that store is the Pull requests page's own,
 * one project at a time, and a chat reading through it would reset the page.
 *
 * NOTE: Main already caches the list for a minute (`pullsCache`), so a read
 * here costs at most one `gh` call per minute per project. Checks are one
 * uncached `gh` call per pull request, so they are kept here for a minute.
 */

/** How long a read is taken as current. */
const FRESH_MS = 60_000;

interface Listed {
  /** The repository the list was read from, the one links must name. */
  repo: RepoRef | null;
  pulls: PullRequest[];
  at: number;
}

interface ProjectPullsState {
  /** By project slug; absent before the first read. */
  lists: Record<string, Listed>;
  /** Pull requests read one by one (not in the list), by `slug#number`. */
  single: Record<string, { pull: PullRequest | null; at: number }>;
  checks: Record<string, { checks: PullChecks | null; at: number }>;
  loading: Record<string, boolean>;
  load: (slug: string) => Promise<void>;
  loadPull: (slug: string, number: number) => Promise<void>;
  loadChecks: (slug: string, number: number) => Promise<void>;
}

const key = (slug: string, number: number) => `${slug}#${number}`;

export const useProjectPulls = create<ProjectPullsState>((set, get) => ({
  lists: {},
  single: {},
  checks: {},
  loading: {},

  async load(slug) {
    const listed = get().lists[slug];
    if (get().loading[slug]) return;
    if (listed && Date.now() - listed.at < FRESH_MS) return;
    set((state) => ({ loading: { ...state.loading, [slug]: true } }));
    try {
      const git = desktopSurface("git");
      const [repo, view] = await Promise.all([
        git.repo(slug).catch(() => null),
        git.pulls(slug, "all").catch(() => null),
      ]);
      set((state) => ({
        lists: {
          ...state.lists,
          [slug]: {
            repo: view?.repo ?? selectedRepo(repo),
            pulls: view?.pulls ?? [],
            at: Date.now(),
          },
        },
      }));
    } finally {
      set((state) => ({ loading: { ...state.loading, [slug]: false } }));
    }
  },

  async loadPull(slug, number) {
    const at = get().single[key(slug, number)];
    if (at && Date.now() - at.at < FRESH_MS) return;
    const detail = await desktopSurface("git")
      .pull(slug, number)
      .catch(() => null);
    set((state) => ({
      single: {
        ...state.single,
        [key(slug, number)]: { pull: detail?.pull ?? null, at: Date.now() },
      },
    }));
  },

  async loadChecks(slug, number) {
    const at = get().checks[key(slug, number)];
    if (at && Date.now() - at.at < FRESH_MS) return;
    const activity = await desktopSurface("git")
      .activity(slug, number)
      .catch(() => null);
    set((state) => ({
      checks: {
        ...state.checks,
        [key(slug, number)]: {
          checks: activity?.checks ?? null,
          at: Date.now(),
        },
      },
    }));
  },
}));

/** The repository `slug`'s pull requests are read from; null while unknown. */
export function useProjectRepo(slug: string | null): RepoRef | null {
  const repo = useProjectPulls((state) =>
    slug ? (state.lists[slug]?.repo ?? null) : null,
  );
  const load = useProjectPulls((state) => state.load);
  useEffect(() => {
    if (slug) void load(slug);
  }, [slug, load]);
  return repo;
}

/**
 * Whether a link's repository is `slug`'s own: only then is it drawn as one
 * of the project's pull requests. Null while the repository is read.
 */
export function useIsProjectRepo(
  slug: string | null,
  ref: RepoRef | null,
): boolean | null {
  const repo = useProjectRepo(slug);
  const read = useProjectPulls((state) =>
    slug ? Boolean(state.lists[slug]) : false,
  );
  if (!slug || !ref) return false;
  if (!read) return null;
  return repo ? sameRepo(repo, ref) : false;
}

/**
 * Pull request `number` of `slug`: from the list, else read alone (an old
 * one past the list's end). Null while read, or when GitHub has none.
 */
export function useProjectPull(
  slug: string | null,
  number: number | null,
): PullRequest | null {
  const listed = useProjectPulls((state) =>
    slug && number !== null
      ? state.lists[slug]?.pulls.find((pull) => pull.number === number)
      : undefined,
  );
  const hasList = useProjectPulls((state) =>
    slug ? Boolean(state.lists[slug]) : false,
  );
  const alone = useProjectPulls((state) =>
    slug && number !== null ? state.single[key(slug, number)]?.pull : null,
  );
  const load = useProjectPulls((state) => state.load);
  const loadPull = useProjectPulls((state) => state.loadPull);
  useEffect(() => {
    if (slug) void load(slug);
  }, [slug, load]);
  useEffect(() => {
    if (slug && number !== null && hasList && !listed)
      void loadPull(slug, number);
  }, [slug, number, hasList, listed, loadPull]);
  return listed ?? alone ?? null;
}

/** Pull request `number`'s checks, read once a minute at most. */
export function usePullChecks(
  slug: string | null,
  number: number | null,
): PullChecks | null {
  const checks = useProjectPulls((state) =>
    slug && number !== null ? state.checks[key(slug, number)]?.checks : null,
  );
  const loadChecks = useProjectPulls((state) => state.loadChecks);
  useEffect(() => {
    if (slug && number !== null) void loadChecks(slug, number);
  }, [slug, number, loadChecks]);
  return checks ?? null;
}

/**
 * The pull requests of a session (FE-174/D1a): each of its branches' (an
 * open one first, else the newest), then the project's own pull requests it
 * printed or wrote about, newest first. Numbers only, once each.
 *
 * NOTE: A link to another repository is dropped, and so is every link while
 * the project's repository is still being read.
 */
export function useSessionPulls(
  slug: string | null,
  branches: readonly (string | null)[],
  links: readonly PullRef[],
): number[] {
  const listed = useProjectPulls((state) =>
    slug ? state.lists[slug] : undefined,
  );
  const load = useProjectPulls((state) => state.load);
  useEffect(() => {
    if (slug) void load(slug);
  }, [slug, load]);
  if (!listed) return [];
  const out: number[] = [];
  const add = (number: number) => {
    if (!out.includes(number)) out.push(number);
  };
  for (const branch of branches) {
    if (!branch) continue;
    const mine = listed.pulls.filter((pull) => pull.headRef === branch);
    const pick =
      mine.find((pull) => pull.state === "open") ??
      [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (pick) add(pick.number);
  }
  if (listed.repo) {
    const repo = listed.repo;
    for (const link of links) if (sameRepo(repo, link)) add(link.number);
  }
  return out;
}
