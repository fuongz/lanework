import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { IssueView } from "#/lib/issue-search";

/**
 * The way each project's issues were last looked at: as a list or as lanes.
 *
 * Remembered, not just carried in the URL (FE-13/D5). The URL is the truth
 * while you are on the page (`?view=board` is what a link or Back restores).
 * But the rail's "Issues" row must pick a view when there is no URL yet, or
 * someone who works from the board lands on the list every time.
 *
 * Keyed by slug, like everything else about a project
 * (`shared/workspaces.ts`). One project as a board and another as a list is
 * the normal case.
 */
interface IssueViewState {
  bySlug: Record<string, IssueView>;
  remember: (slug: string, view: IssueView) => void;
}

export const useIssueView = create<IssueViewState>()(
  persist(
    (set) => ({
      bySlug: {},
      remember: (slug, view) =>
        set((state) =>
          state.bySlug[slug] === view
            ? state
            : { bySlug: { ...state.bySlug, [slug]: view } },
        ),
    }),
    {
      name: "lanework-issue-view",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ bySlug }) => ({ bySlug }),
      // An unknown value from a future build falls back to the list rather
      // than handing the router a view it cannot draw.
      merge: (persisted, current) => {
        const saved = (persisted as { bySlug?: unknown } | null)?.bySlug;
        const bySlug: Record<string, IssueView> = {};
        if (saved && typeof saved === "object") {
          for (const [slug, view] of Object.entries(saved)) {
            if (view === "board" || view === "list") bySlug[slug] = view;
          }
        }
        return { ...current, bySlug };
      },
    },
  ),
);
