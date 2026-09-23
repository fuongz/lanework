import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isThemeSource, type ThemeSource } from "../../shared/desktop";

interface Preferences {
  theme: ThemeSource;
  setTheme: (value: ThemeSource) => void;
  /**
   * Whether the first-run tour has been walked through on this machine.
   *
   * Local, not account-wide, and deliberately: the tour runs BEFORE sign-in —
   * there is no account to hang it off yet — and what it asks (the appearance)
   * is a per-machine choice anyway.
   */
  onboarded: boolean;
  completeOnboarding: () => void;
  /**
   * True once `persist.rehydrate()` has settled.
   *
   * ⚠️ Read this before branching on `onboarded`. Hydration is skipped at
   * creation (see `skipHydration`), so for the first render every install looks
   * brand new — without this flag a returning machine flashes the welcome step
   * on its way to the sign-in screen.
   */
  hydrated: boolean;
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      onboarded: false,
      completeOnboarding: () => set({ onboarded: true }),
      hydrated: false,
    }),
    {
      name: "lanework-preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({ theme, onboarded }) => ({ theme, onboarded }),
      onRehydrateStorage: () => () =>
        usePreferences.setState({ hydrated: true }),
      // ⚠️ Still version 1, and `compact` simply stops being read. A bump would
      // discard everyone's saved theme to drop a key that is already ignored;
      // an unknown value falls back here either way.
      merge: (persisted, current) => {
        const saved = persisted as Partial<Preferences> | null;
        return {
          ...current,
          theme: isThemeSource(saved?.theme) ? saved.theme : "system",
          // A record that predates this key belongs to someone who has already
          // used the app; only a machine with NOTHING saved is actually new.
          // Otherwise shipping the tour would replay it for every existing
          // install the next time it reached the gate.
          onboarded: saved ? saved.onboarded !== false : false,
        };
      },
    },
  ),
);
