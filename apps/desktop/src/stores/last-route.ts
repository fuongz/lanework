import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { create } from "zustand";

/**
 * Where each project was last looked at: the full href, search included.
 *
 * Switching projects and back lands where you left (an agent's terminal, a
 * pull request, a commit), not on the issues list. The terminal panel keeps
 * its own tab per project (`stores/terminal.ts`); this is the route under it.
 *
 * NOTE: Not persisted. A relaunch has none of the terminals it most often
 * points at, and an href to an agent that no longer exists is not a place to
 * reopen a project.
 */
interface LastRouteState {
  bySlug: Record<string, string>;
  remember: (slug: string, href: string) => void;
}

export const useLastRoute = create<LastRouteState>((set) => ({
  bySlug: {},
  remember: (slug, href) =>
    set((state) =>
      state.bySlug[slug] === href
        ? state
        : { bySlug: { ...state.bySlug, [slug]: href } },
    ),
}));

/**
 * A callback that opens a project where it was left.
 *
 * The first time, it opens the project's issues.
 */
export function useOpenProject() {
  const navigate = useNavigate();
  return useCallback(
    (slug: string) => {
      const href = useLastRoute.getState().bySlug[slug];
      void (href
        ? navigate({ href })
        : navigate({ to: "/w/$slug/issues", params: { slug }, search: {} }));
    },
    [navigate],
  );
}
