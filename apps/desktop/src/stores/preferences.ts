import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isThemeSource, type ThemeSource } from "../../shared/desktop";

interface Preferences {
  theme: ThemeSource;
  setTheme: (value: ThemeSource) => void;
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "lanework-preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({ theme }) => ({ theme }),
      // ⚠️ Still version 1, and `compact` simply stops being read. A bump would
      // discard everyone's saved theme to drop a key that is already ignored;
      // an unknown value falls back here either way.
      merge: (persisted, current) => {
        const saved = persisted as Partial<Preferences> | null;
        return {
          ...current,
          theme: isThemeSource(saved?.theme) ? saved.theme : "system",
        };
      },
    },
  ),
);
