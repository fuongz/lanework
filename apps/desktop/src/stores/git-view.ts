import { create } from "zustand";

export type GitTab = "changes" | "history";

interface GitPlace {
  /** The tab last shown. */
  tab: GitTab;
  /** The commit last open in History, or null when none was. */
  sha: string | null;
}

/**
 * Where each project's Git view was left (FE-130/D4, D9).
 *
 * The rail's one Git entry opens the tab last used, and the History tab
 * returns to the commit last open there, so going to Changes and back does
 * not lose it.
 *
 * NOTE: Not persisted, like `last-route.ts`: a relaunch reads the repository
 * again, and a commit from before it may have been rewritten since.
 */
interface GitViewState {
  bySlug: Record<string, GitPlace>;
  /** `sha` is left as it was when omitted (a visit to the Changes tab). */
  remember: (slug: string, tab: GitTab, sha?: string | null) => void;
}

export const useGitView = create<GitViewState>((set) => ({
  bySlug: {},
  remember: (slug, tab, sha) =>
    set((state) => {
      const current = state.bySlug[slug];
      const next: GitPlace = {
        tab,
        sha: sha === undefined ? (current?.sha ?? null) : sha,
      };
      return current?.tab === next.tab && current.sha === next.sha
        ? state
        : { bySlug: { ...state.bySlug, [slug]: next } };
    }),
}));
