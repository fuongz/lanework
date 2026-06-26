import { create } from "zustand";
import { getAllRepos } from "@/server/reviews";
import type { Repo } from "@/lib/github";

interface RepoState {
  /** Full repo list (up to 100), or null until first loaded. */
  repos: Repo[] | null;
  loading: boolean;
  /** Fetch the full list once per session; subsequent calls are no-ops. */
  ensureLoaded: () => void;
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repos: null,
  loading: false,
  ensureLoaded: () => {
    if (get().repos || get().loading) return;
    set({ loading: true });
    getAllRepos()
      .then((repos) => set({ repos, loading: false }))
      .catch(() => set({ loading: false }));
  },
}));
