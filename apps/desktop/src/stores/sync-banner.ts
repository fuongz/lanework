import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Which local projects had their "sync to cloud" banner put off (FE-122).
 *
 * Kept on this machine, in `localStorage`, by local project id: putting the
 * invitation off is a choice about this window, not a fact about the board.
 * The action itself never goes away; the board's own bar and Settings still
 * offer it.
 */
interface SyncBannerState {
  hidden: string[];
  hide: (projectId: string) => void;
}

export const useSyncBanner = create<SyncBannerState>()(
  persist(
    (set) => ({
      hidden: [],
      hide: (projectId) =>
        set((state) =>
          state.hidden.includes(projectId)
            ? state
            : { hidden: [...state.hidden, projectId] },
        ),
    }),
    {
      name: "lanework:sync-banner:hidden",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ hidden }) => ({ hidden }),
      // Anything but a list of strings from another build reads as none hidden.
      merge: (persisted, current) => {
        const saved = (persisted as { hidden?: unknown } | null)?.hidden;
        return {
          ...current,
          hidden: Array.isArray(saved)
            ? saved.filter((id): id is string => typeof id === "string")
            : [],
        };
      },
    },
  ),
);
