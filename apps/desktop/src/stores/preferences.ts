import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isThemeSource, type ThemeSource } from "../../shared/desktop";
import {
  type DictationCorrection,
  type DictationLocale,
  isDictationLocale,
} from "../../shared/dictation";

/** One installed font, as a picker saves it: the family and one style. */
export interface FontChoice {
  family: string;
  /** The style's own name, as the font calls it: "Regular", "Medium"… */
  style: string;
  weight: number;
}

/**
 * The font picked for each role.
 *
 * A role left `null` falls back: UI and code to the app's, content to UI's.
 */
export interface FontPreferences {
  ui: FontChoice | null;
  content: FontChoice | null;
  code: FontChoice | null;
}

export type FontRole = keyof FontPreferences;

const NO_FONTS: FontPreferences = { ui: null, content: null, code: null };

function isFontChoice(value: unknown): value is FontChoice {
  if (!value || typeof value !== "object") return false;
  const { family, style, weight } = value as Record<string, unknown>;
  return (
    typeof family === "string" &&
    family.length > 0 &&
    typeof style === "string" &&
    typeof weight === "number" &&
    weight >= 1 &&
    weight <= 1000
  );
}

function readFonts(value: unknown): FontPreferences {
  if (!value || typeof value !== "object") return NO_FONTS;
  const saved = value as Record<string, unknown>;
  const pick = (role: FontRole) => {
    const choice = saved[role];
    return isFontChoice(choice) ? choice : null;
  };
  return { ui: pick("ui"), content: pick("content"), code: pick("code") };
}

/** How the project switcher orders its list. */
export const PROJECT_SORTS = ["default", "name", "activate"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

function readCorrections(value: unknown): DictationCorrection[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (rule): rule is DictationCorrection =>
      !!rule &&
      typeof rule.to === "string" &&
      Array.isArray(rule.from) &&
      rule.from.every((word: unknown) => typeof word === "string"),
  );
}

function isProjectSort(value: unknown): value is ProjectSort {
  return (
    typeof value === "string" &&
    (PROJECT_SORTS as readonly string[]).includes(value)
  );
}

interface Preferences {
  theme: ThemeSource;
  setTheme: (value: ThemeSource) => void;
  /** The fonts picked on this machine, like the theme. */
  fonts: FontPreferences;
  setFont: (role: FontRole, value: FontChoice | null) => void;
  /**
   * Whether the first-run tour has been walked through on this machine.
   *
   * Local, not account-wide: the tour runs before sign-in, when there is no
   * account yet, and what it asks (the appearance) is a per-machine choice.
   */
  onboarded: boolean;
  completeOnboarding: () => void;
  /**
   * The project switcher's order.
   *
   * Kept here rather than in the switcher, so it survives a restart and the
   * rail's two forms share one choice.
   */
  projectSort: ProjectSort;
  setProjectSort: (value: ProjectSort) => void;
  /** The language the composer's microphone listens for (FE-69/D6). */
  dictationLocale: DictationLocale;
  setDictationLocale: (value: DictationLocale) => void;
  /**
   * The fixes applied to what was heard (FE-69/D5).
   *
   * Null until edited in Settings, and null reads as `DEFAULT_CORRECTIONS`,
   * so a later default reaches everyone who never changed theirs.
   */
  dictationCorrections: DictationCorrection[] | null;
  setDictationCorrections: (value: DictationCorrection[] | null) => void;
  /**
   * True once `persist.rehydrate()` has settled.
   *
   * NOTE: Read this before branching on `onboarded`. Hydration is skipped at
   * creation (see `skipHydration`), so on the first render every install looks
   * brand new. Without this flag a returning machine flashes the welcome step
   * on its way to the sign-in screen.
   */
  hydrated: boolean;
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
      fonts: NO_FONTS,
      setFont: (role, value) =>
        set((state) => ({ fonts: { ...state.fonts, [role]: value } })),
      onboarded: false,
      completeOnboarding: () => set({ onboarded: true }),
      projectSort: "default",
      setProjectSort: (projectSort) => set({ projectSort }),
      dictationLocale: "vi_VN",
      setDictationLocale: (dictationLocale) => set({ dictationLocale }),
      dictationCorrections: null,
      setDictationCorrections: (dictationCorrections) =>
        set({ dictationCorrections }),
      hydrated: false,
    }),
    {
      name: "lanework-preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({
        theme,
        onboarded,
        fonts,
        projectSort,
        dictationLocale,
        dictationCorrections,
      }) => ({
        theme,
        onboarded,
        fonts,
        projectSort,
        dictationLocale,
        dictationCorrections,
      }),
      onRehydrateStorage: () => () =>
        usePreferences.setState({ hydrated: true }),
      // NOTE: Stays version 1; a dropped key such as `compact` is just not
      // read. A bump would discard everyone's saved theme, and an unknown
      // value falls back here either way.
      merge: (persisted, current) => {
        const saved = persisted as Partial<Preferences> | null;
        return {
          ...current,
          theme: isThemeSource(saved?.theme) ? saved.theme : "system",
          // A record without fonts reads as the defaults, and a malformed one
          // as the defaults role by role.
          fonts: readFonts(saved?.fonts),
          // Missing or unknown reads as the default order.
          projectSort: isProjectSort(saved?.projectSort)
            ? saved.projectSort
            : "default",
          dictationLocale: isDictationLocale(saved?.dictationLocale)
            ? saved.dictationLocale
            : "vi_VN",
          dictationCorrections: readCorrections(saved?.dictationCorrections),
          // A record without this key belongs to someone who has already used
          // the app; only a machine with nothing saved is new. Otherwise the
          // tour would replay for every install that predates it.
          onboarded: saved ? saved.onboarded !== false : false,
        };
      },
    },
  ),
);
