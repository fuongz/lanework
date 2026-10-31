import {
  AiChipIcon,
  Archive02Icon,
  CommandLineIcon,
  DashboardSquare02Icon,
  InformationCircleIcon,
  JusticeScale01Icon,
  KeyboardIcon,
  MagicWand01Icon,
  McpServerIcon,
  Mic01Icon,
  Notification01Icon,
  Sun01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
// Type-only: `lib/` stays framework-free at runtime, and this keeps the nav's
// destinations checked against the real route tree instead of loose strings.
import type { LinkProps } from "@tanstack/react-router";

/** An icon from `@hugeicons/core-free-icons`: data, not a component. */
type SettingsIcon = typeof Sun01Icon;

interface SettingsItem {
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
        keywords: "theme dark light system colour color mode font",
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
          "harness cli agent agents claude code codex version update install usage limit quota handoff checkpoint resume hook push wip lanework mcp sign in pull sessions import conversations transcripts",
      },
      {
        to: "/settings/models",
        label: "Models",
        icon: AiChipIcon,
        keywords:
          "models model picker show hide visible hidden claude codex opencode provider go",
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
        keywords: "skills skill SKILL.md claude codex agents edit global user",
      },
      {
        to: "/settings/mcp",
        label: "MCP",
        icon: McpServerIcon,
        keywords:
          "mcp server servers global user claude.json config.toml stdio http sse",
      },
    ],
  },
  {
    // Its pages are about ONE project, picked in each page's title bar
    // (`SettingsProjectPicker`) and shared by all three.
    label: "Project",
    items: [
      {
        to: "/settings/projects",
        label: "General",
        icon: DashboardSquare02Icon,
        keywords:
          "project projects workspace general rename folder folders import readiness ready danger delete remove issues sync cloud",
      },
      {
        to: "/settings/project-skills",
        label: "Skills",
        icon: MagicWand01Icon,
        keywords: "project skills skill SKILL.md .claude .agents .codex repo",
      },
      {
        to: "/settings/project-mcp",
        label: "MCP",
        icon: McpServerIcon,
        keywords: "project mcp server servers .mcp.json local repo",
      },
      {
        to: "/settings/project-archived",
        label: "Archived",
        icon: Archive02Icon,
        keywords:
          "project archived archive unarchive agents conversations sessions claude codex",
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
