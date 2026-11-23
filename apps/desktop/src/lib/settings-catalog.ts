import {
  Archive02Icon,
  BatteryEcoChargingIcon,
  CommandLineIcon,
  DashboardSquare02Icon,
  HardDriveIcon,
  InformationCircleIcon,
  JusticeScale01Icon,
  KeyboardIcon,
  MagicWand01Icon,
  McpServerIcon,
  Mic01Icon,
  Notification01Icon,
  Shield01Icon,
  Sun01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
// Type-only: `lib/` stays framework-free at runtime, and this keeps the nav's
// destinations checked against the real route tree instead of loose strings.
import type { LinkProps } from "@tanstack/react-router";

/** An icon from `@hugeicons/core-free-icons`: data, not a component. */
type SettingsIcon = typeof Sun01Icon;

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

interface SettingsGroup {
  label: string;
  items: SettingsItem[];
}

/**
 * The sidebar, and the only list of settings sections there is.
 *
 * Only sections with real content appear (FE-02 S1). A nav item that leads
 * nowhere costs the reader a click to learn nothing.
 *
 * NOTE: Agents (the hook page), Memory, Instructions and Config files are
 * left out of the nav for now, not removed: their routes still answer. What
 * the Agents page did lives in Harness — `/settings/agents` sends you there.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "App",
    items: [
      {
        to: "/settings/appearance",
        label: "Appearance",
        icon: Sun01Icon,
        keywords:
          "theme dark light system colour color mode font accent brand primary",
      },
      {
        to: "/settings/dictation",
        label: "Dictation",
        icon: Mic01Icon,
        keywords:
          "dictation voice speech microphone mic language vietnamese corrections",
      },
      {
        to: "/settings/notifications",
        label: "Notifications",
        icon: Notification01Icon,
        keywords:
          "notifications notification notify push alert os agent session sessions finished done pull request pr new",
      },
      {
        to: "/settings/power",
        label: "Power saver",
        icon: BatteryEcoChargingIcon,
        keywords:
          "power saver battery energy idle end stop chat agent engine keep running heat cpu memory lwk search engine find grep serve on demand always per search",
      },
      {
        to: "/settings/storage",
        label: "Storage",
        icon: HardDriveIcon,
        keywords:
          "storage disk space size cache clear free app data folder worktrees runs checkouts",
      },
      {
        to: "/settings/keybindings",
        label: "Keybindings",
        icon: KeyboardIcon,
        keywords:
          "keybindings keyboard shortcuts shortcut hotkeys keys command palette",
      },
      {
        to: "/settings/about",
        label: "About",
        icon: InformationCircleIcon,
        keywords:
          "version platform control plane status build resource log diagnostics telemetry metrics cpu memory",
      },
    ],
  },
  {
    label: "Agents",
    items: [
      {
        to: "/settings/harness",
        label: "Harness",
        icon: CommandLineIcon,
        keywords:
          "models model picker favourite favorite star order reorder show hide visible hidden slug provider harness cli agent agents claude code codex version update install usage limit quota handoff checkpoint resume hook push wip lanework mcp sign in pull sessions import conversations transcripts",
      },
      {
        to: "/settings/decision",
        label: "Decision",
        icon: JusticeScale01Icon,
        keywords:
          "decision jev judge typesafe openrouter local ollama threshold shadow enforce tier model api key test connection orchestration lead worker",
      },
      {
        to: "/settings/skills",
        label: "Skills",
        icon: MagicWand01Icon,
        keywords:
          "skills skill SKILL.md claude codex agents edit global user project .claude .agents .codex repo",
      },
      {
        to: "/settings/mcp",
        label: "MCP",
        icon: McpServerIcon,
        keywords:
          "mcp server servers global user claude.json config.toml stdio http sse project .mcp.json local repo",
      },
      {
        to: "/settings/permissions",
        label: "Permissions",
        icon: Shield01Icon,
        keywords:
          "permissions permission rules rule allow always ask first automatic automatically seeded audit recent bash edit write read tool pattern conductor scope approve deny",
      },
      {
        to: "/settings/archived",
        label: "Archived",
        icon: Archive02Icon,
        keywords:
          "project archived archive unarchive agents conversations sessions claude codex",
      },
    ],
  },
  {
    // One row: the list of projects, each opening its own page
    // (`/settings/projects/$slug`). Skills, MCP and Archived above carry
    // a project picker of their own (FE-145).
    label: "Code",
    items: [
      {
        to: "/settings/projects",
        label: "Projects",
        icon: DashboardSquare02Icon,
        keywords:
          "project projects workspace general rename folder folders import readiness ready danger delete remove issues sync cloud",
      },
    ],
  },
  {
    label: "Cloud",
    items: [
      {
        to: "/settings/account",
        label: "Account",
        icon: UserAccountIcon,
        keywords:
          "account sign in sign out signed in user machine revoke credential cloud",
      },
    ],
  },
];

/**
 * Pages with a route but no nav item, by the name their breadcrumb shows.
 *
 * Hidden for now (see {@link SETTINGS_GROUPS}), yet their address still
 * answers, and a header must not go blank there.
 */
const HIDDEN_TITLES: Record<string, string> = {
  "/settings/config": "Config files",
  "/settings/memory": "Memory",
  "/settings/instructions": "Instructions",
};

/**
 * The name of the settings page at `pathname`, for its breadcrumb.
 *
 * Read from the nav, so a page's header and its sidebar row never disagree.
 * A sub-page (`/settings/projects/acme`) gets its section's name.
 *
 * @returns Null outside any known page.
 */
export function settingsTitle(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "");
  const within = (to: string) => path === to || path.startsWith(`${to}/`);
  for (const group of SETTINGS_GROUPS)
    for (const item of group.items)
      if (typeof item.to === "string" && within(item.to)) return item.label;
  for (const [to, title] of Object.entries(HIDDEN_TITLES))
    if (within(to)) return title;
  return null;
}

/**
 * Whether `query` matches any of `text`.
 *
 * A case-insensitive substring, not fuzzy: with a handful of
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
