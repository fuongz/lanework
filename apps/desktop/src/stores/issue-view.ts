import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * How the issues screen is laid out, beyond its column widths.
 *
 * Remembered app-wide, not per project (FE-75/D9): it is how somebody likes
 * to read an issue, not a fact about one board. The list's width is kept
 * beside it by the panel group, under the same `lanework:issues` prefix.
 */
interface IssueViewState {
  /** Whether an issue's Properties panel shares the pane with its body. */
  propertiesOpen: boolean;
  toggleProperties: () => void;
}

export const useIssueView = create<IssueViewState>()(
  persist(
    (set) => ({
      propertiesOpen: true,
      toggleProperties: () =>
        set((state) => ({ propertiesOpen: !state.propertiesOpen })),
    }),
    {
      name: "lanework:issues:properties",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ propertiesOpen }) => ({ propertiesOpen }),
      // A value of the wrong type from another build falls back to open.
      merge: (persisted, current) => {
        const saved = (persisted as { propertiesOpen?: unknown } | null)
          ?.propertiesOpen;
        return {
          ...current,
          propertiesOpen: typeof saved === "boolean" ? saved : true,
        };
      },
    },
  ),
);
