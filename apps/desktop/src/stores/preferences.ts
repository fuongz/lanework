import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface Preferences {
  compact: boolean;
  setCompact: (value: boolean) => void;
}
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      compact: false,
      setCompact: (compact) => set({ compact }),
    }),
    {
      name: "lanework-preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({ compact }) => ({ compact }),
      merge: (persisted, current) => ({
        ...current,
        compact:
          typeof (persisted as Partial<Preferences> | null)?.compact ===
          "boolean"
            ? (persisted as Preferences).compact
            : false,
      }),
    },
  ),
);
