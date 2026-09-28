import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { create } from "zustand";

/**
 * Where each project was last looked at — the full href, search included.
 *
 * ⚠️ So switching projects and back lands where you left, not on the issues
 * list: an agent's terminal, a pull request, a commit. The terminal panel
 * already keeps its own tab per project (`stores/terminal.ts`); this is the
 * route under it.
 *
 * ⚠️ NOT persisted. It is memory for this run of the window, like the
 * terminals it most often points at — a relaunch has none of them left, and an
 * href to an agent that no longer exists is not a place to reopen a project.
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

/** Open a project where it was left, or at its issues the first time. */
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
