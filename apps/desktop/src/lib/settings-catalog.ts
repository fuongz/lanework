import {
  InformationCircleIcon,
  Sun01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
// Type-only: `lib/` stays framework-free at runtime, and this keeps the nav's
// destinations checked against the real route tree instead of loose strings.
import type { LinkProps } from "@tanstack/react-router";

/** Icon payload shape from `@hugeicons/core-free-icons` — data, not a component. */
export type SettingsIcon = typeof Sun01Icon;

export interface SettingsItem {
  /** Typed destination, checked against the generated route tree. */
  to: LinkProps["to"];
  label: string;
  icon: SettingsIcon;
  /**
   * Extra words the search box matches on.
   *
   * This is the search INDEX for the sidebar: a row lives in a section
   * component and can filter itself, but the nav has to know a section matches
   * without rendering it. Keep these in step with the rows on that page — a
   * setting nobody can find is worse than one that is merely hard to reach.
   */
  keywords: string;
}

export interface SettingsGroup {
  label: string;
  items: SettingsItem[];
}

/**
 * The sidebar, and the only list of settings sections there is.
 *
 * Only sections with real content appear (FE-02 S1). A nav item that leads
 * nowhere costs the reader a click to learn nothing.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Personal",
    items: [
      {
        to: "/settings/appearance",
        label: "Appearance",
        icon: Sun01Icon,
        keywords: "theme dark light system colour color mode",
      },
      {
        to: "/settings/account",
        label: "Account",
        icon: UserAccountIcon,
        keywords: "sign out signed in user machine revoke credential",
      },
    ],
  },
  {
    label: "App",
    items: [
      {
        to: "/settings/about",
        label: "About",
        icon: InformationCircleIcon,
        keywords: "version platform control plane status build",
      },
    ],
  },
];

/** Every item, flattened — for lookups that do not care about grouping. */
export const SETTINGS_ITEMS: SettingsItem[] = SETTINGS_GROUPS.flatMap(
  (group) => group.items,
);

/**
 * Does `query` match any of `text`?
 *
 * Case-insensitive substring, deliberately not fuzzy: with a handful of
 * settings, fuzzy matching mostly produces surprises. An empty query matches
 * everything, which is what makes "not searching" the same code path.
 */
export function matches(
  query: string,
  ...text: (string | undefined)[]
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return text.some((value) => value?.toLowerCase().includes(needle));
}
