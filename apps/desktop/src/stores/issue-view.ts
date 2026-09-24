import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { IssueView } from "#/lib/issue-search";

/**
 * The way each project's issues were last looked at: as a list or as lanes.
 *
 * ⚠️ Remembered, not just carried in the URL (FE-13/D5). The URL is still the
 * truth while you are on the page — `?view=board` is what a link or Back
 * restores — but the rail's "Issues" row has to pick SOMETHING when there is
 * no URL yet, and a person who works from the board would otherwise be sent
 * to the list every single time they came back to it.
 *
 * ⚠️ Keyed by slug, the same key everything else about a project hangs off
 * (`shared/workspaces.ts`): one project read as a board and another as a list
 * is the normal case, not an edge.
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
