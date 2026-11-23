import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { readAccent } from "#/lib/accent";
import {
  CUSTOM_MODELS_MAX,
  type CustomModel,
  isModelIdFor,
} from "../../shared/conversation";
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

/**
 * Whether the composer's picker offers `entry`: not hidden, and, for a
 * deprecated model, turned on by hand (off until then).
 */
export function isModelOffered(
  entry: { id: string; legacy?: boolean },
  hidden: ReadonlySet<string> | readonly string[],
  shown: ReadonlySet<string> | readonly string[],
): boolean {
  const has = (list: ReadonlySet<string> | readonly string[], id: string) =>
    Array.isArray(list)
      ? list.includes(id)
      : (list as ReadonlySet<string>).has(id);
  if (has(hidden, entry.id)) return false;
  return !entry.legacy || has(shown, entry.id);
}

/** The most model ids kept hidden: every CLI's list, with room to spare. */
const HIDDEN_MAX = 2000;

function readHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string =>
          typeof id === "string" && id.length > 0 && id.length <= 200,
      ),
    ),
  ].slice(0, HIDDEN_MAX);
}

/** The picker's stars from before FE-146, under their own key. */
function legacyFavorites(): unknown {
  try {
    const raw = localStorage.getItem("lanework.conversation.favorite-models");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function readCustomModels(value: unknown): CustomModel[] {
  if (!Array.isArray(value)) return [];
  const out: CustomModel[] = [];
  for (const entry of value.slice(0, CUSTOM_MODELS_MAX)) {
    if (!entry || typeof entry !== "object") continue;
    const { agent, id, label } = entry as Record<string, unknown>;
    if (
      (agent !== "claude" && agent !== "codex" && agent !== "opencode") ||
      typeof id !== "string" ||
      !isModelIdFor(agent, id) ||
      out.some((kept) => kept.id === id)
    )
      continue;
    out.push({
      agent,
      id,
      label: typeof label === "string" ? label.slice(0, 80) : "",
    });
  }
  return out;
}

function readModelOrder(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(value)) {
    const kept = readHidden(ids);
    if (group.length <= 200 && kept.length) out[group] = kept;
  }
  return out;
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
  /**
   * The accent colour picked on this machine, as `#rrggbb` (FE-143). Null is
   * Lanework's own orange.
   */
  accent: string | null;
  setAccent: (value: string | null) => void;
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
  /**
   * The namespaces folded shut in the project switcher: the text before the
   * first "/" of a project's name. Every group starts open.
   */
  collapsedNamespaces: string[];
  /**
   * Whether the project switcher folds projects that share a namespace under
   * one header (Settings → Appearance). On unless turned off.
   */
  groupProjects: boolean;
  setGroupProjects: (value: boolean) => void;
  setNamespaceCollapsed: (namespace: string, collapsed: boolean) => void;
  /**
   * The projects pinned in the switcher, by slug, in the order pinned. A
   * pinned project leads the list as a row of its own, above every group and
   * whatever the sort or the saved order.
   */
  pinnedProjects: string[];
  setProjectPinned: (slug: string, pinned: boolean) => void;
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
   * The models the composer's picker leaves out, by id (Settings → Models).
   * Lanework's own list: a CLI's own picker is not read or changed.
   */
  hiddenModels: string[];
  setModelsHidden: (ids: readonly string[], hidden: boolean) => void;
  /**
   * The deprecated models turned on by hand: a deprecated one is off in the
   * picker until it is here ({@link isModelOffered}).
   */
  shownModels: string[];
  /** Offer `entries` in the picker or not, deprecated ones included. */
  setModelsShown: (
    entries: readonly { id: string; legacy?: boolean }[],
    shown: boolean,
  ) => void;
  /**
   * The models starred in Settings → Harness or the picker (FE-146): the
   * picker's Favourites, and first in their CLI's tab.
   */
  favoriteModels: string[];
  setModelFavorite: (id: string, favorite: boolean) => void;
  /**
   * The order the user put a group's models in, by group key: `claude`,
   * `codex`, or `opencode:<provider>` (FE-146). A group without one keeps
   * the CLI's own order; models the order does not name follow it.
   */
  modelOrder: Record<string, string[]>;
  setModelOrder: (group: string, ids: readonly string[] | null) => void;
  /**
   * Models the user added in Settings → Harness (FE-146), given to their CLI
   * as typed. Main is told them too (`useCustomModels`).
   */
  customModels: CustomModel[];
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  /**
   * Whether the island's toasts make a sound: a short synthesized cue per
   * new toast or change of status. Off unless turned on.
   */
  islandSound: boolean;
  setIslandSound: (value: boolean) => void;
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
      accent: null,
      setAccent: (value) => set({ accent: readAccent(value) }),
      fonts: NO_FONTS,
      setFont: (role, value) =>
        set((state) => ({ fonts: { ...state.fonts, [role]: value } })),
      onboarded: false,
      completeOnboarding: () => set({ onboarded: true }),
      projectSort: "default",
      setProjectSort: (projectSort) => set({ projectSort }),
      collapsedNamespaces: [],
      groupProjects: true,
      setGroupProjects: (groupProjects) => set({ groupProjects }),
      setNamespaceCollapsed: (namespace, collapsed) =>
        set((state) => {
          const next = new Set(state.collapsedNamespaces);
          if (collapsed) next.add(namespace);
          else next.delete(namespace);
          return { collapsedNamespaces: readHidden([...next]) };
        }),
      pinnedProjects: [],
      setProjectPinned: (slug, pinned) =>
        set((state) => {
          const rest = state.pinnedProjects.filter((entry) => entry !== slug);
          return {
            pinnedProjects: readHidden(pinned ? [...rest, slug] : rest),
          };
        }),
      dictationLocale: "vi_VN",
      setDictationLocale: (dictationLocale) => set({ dictationLocale }),
      dictationCorrections: null,
      setDictationCorrections: (dictationCorrections) =>
        set({ dictationCorrections }),
      hiddenModels: [],
      setModelsHidden: (ids, hidden) =>
        set((state) => {
          const next = new Set(state.hiddenModels);
          for (const id of ids)
            if (hidden) next.add(id);
            else next.delete(id);
          return { hiddenModels: readHidden([...next]) };
        }),
      shownModels: [],
      setModelsShown: (entries, shown) =>
        set((state) => {
          const hidden = new Set(state.hiddenModels);
          const opted = new Set(state.shownModels);
          for (const { id, legacy } of entries) {
            if (shown) {
              hidden.delete(id);
              if (legacy) opted.add(id);
            } else {
              hidden.add(id);
              opted.delete(id);
            }
          }
          return {
            hiddenModels: readHidden([...hidden]),
            shownModels: readHidden([...opted]),
          };
        }),
      favoriteModels: [],
      setModelFavorite: (id, favorite) =>
        set((state) => {
          const next = state.favoriteModels.filter((entry) => entry !== id);
          return {
            favoriteModels: readHidden(favorite ? [...next, id] : next),
          };
        }),
      modelOrder: {},
      customModels: [],
      addCustomModel: (model) =>
        set((state) => ({
          customModels: readCustomModels([
            ...state.customModels.filter((entry) => entry.id !== model.id),
            model,
          ]),
        })),
      removeCustomModel: (id) =>
        set((state) => ({
          customModels: state.customModels.filter((entry) => entry.id !== id),
          favoriteModels: state.favoriteModels.filter((entry) => entry !== id),
        })),
      setModelOrder: (group, ids) =>
        set((state) => {
          const next = { ...state.modelOrder };
          if (ids === null) delete next[group];
          else next[group] = readHidden([...ids]);
          return { modelOrder: next };
        }),
      islandSound: false,
      setIslandSound: (islandSound) => set({ islandSound }),
      hydrated: false,
    }),
    {
      name: "lanework-preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({
        theme,
        accent,
        onboarded,
        fonts,
        projectSort,
        collapsedNamespaces,
        groupProjects,
        pinnedProjects,
        dictationLocale,
        dictationCorrections,
        hiddenModels,
        shownModels,
        favoriteModels,
        modelOrder,
        customModels,
        islandSound,
      }) => ({
        theme,
        accent,
        onboarded,
        fonts,
        projectSort,
        collapsedNamespaces,
        groupProjects,
        pinnedProjects,
        dictationLocale,
        dictationCorrections,
        hiddenModels,
        shownModels,
        favoriteModels,
        modelOrder,
        customModels,
        islandSound,
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
          // Missing or malformed reads as Lanework's own orange.
          accent: readAccent(saved?.accent),
          // A record without fonts reads as the defaults, and a malformed one
          // as the defaults role by role.
          fonts: readFonts(saved?.fonts),
          // Missing or unknown reads as the default order.
          projectSort: isProjectSort(saved?.projectSort)
            ? saved.projectSort
            : "default",
          collapsedNamespaces: readHidden(saved?.collapsedNamespaces),
          groupProjects: saved?.groupProjects !== false,
          pinnedProjects: readHidden(saved?.pinnedProjects),
          dictationLocale: isDictationLocale(saved?.dictationLocale)
            ? saved.dictationLocale
            : "vi_VN",
          dictationCorrections: readCorrections(saved?.dictationCorrections),
          hiddenModels: readHidden(saved?.hiddenModels),
          shownModels: readHidden(saved?.shownModels),
          // Before FE-146 the picker kept its stars under a key of its own:
          // read once from there, so nobody loses theirs.
          favoriteModels:
            saved?.favoriteModels === undefined
              ? readHidden(legacyFavorites())
              : readHidden(saved.favoriteModels),
          modelOrder: readModelOrder(saved?.modelOrder),
          customModels: readCustomModels(saved?.customModels),
          // Missing, or anything but true, reads as off.
          islandSound: saved?.islandSound === true,
          // A record without this key belongs to someone who has already used
          // the app; only a machine with nothing saved is new. Otherwise the
          // tour would replay for every install that predates it.
          onboarded: saved ? saved.onboarded !== false : false,
        };
      },
    },
  ),
);
