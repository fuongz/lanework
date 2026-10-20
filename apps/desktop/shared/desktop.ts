import type { DesktopAgentConfigApi } from "./agent-config";
import type { DesktopAgentSetupApi } from "./agent-setup";
import type { DesktopAuthApi, DesktopLaneworkMcpApi } from "./auth";
import type { DesktopConversationApi } from "./conversation";
import type { DesktopDictationApi } from "./dictation";
import type { DesktopGitApi } from "./git";
import type { DesktopHandoffApi } from "./handoff";
import type { DesktopHarnessApi } from "./harness";
import type { DesktopInstructionsApi } from "./instructions";
import type { DesktopMemoryApi } from "./memory";
import type { DesktopReadinessApi } from "./readiness";
import type { DesktopTerminalApi } from "./terminal";
import type { DesktopWorkspacesApi } from "./workspaces";
import type { DesktopWorktreeApi } from "./worktree";

export const channels = {
  appInfo: "app:get-info",
  setTheme: "app:set-theme",
  themeChanged: "app:theme-changed",
  /** Main → renderer: a View-menu command for the window's layout. */
  viewCommand: "app:view-command",
} as const;

/** What the View menu can ask of the window's layout (FE-20). */
export type ViewCommand = "toggle-sidebar" | "open-settings";

/**
 * Which appearance the window should follow.
 *
 * The same three values Electron's `nativeTheme.themeSource` takes, on purpose:
 * main hands this straight to it, so there is nothing to translate and no
 * fourth state to reconcile.
 */
export type ThemeSource = "system" | "light" | "dark";

export const THEME_SOURCES: ThemeSource[] = ["system", "light", "dark"];

export function isThemeSource(value: unknown): value is ThemeSource {
  return THEME_SOURCES.includes(value as ThemeSource);
}
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}
export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  /**
   * Switch the native theme and answer with whether the window is now dark.
   *
   * ⚠️ Main RESOLVES the theme; the renderer must not. `prefers-color-scheme`
   * does NOT follow `nativeTheme.themeSource` in this Electron build — verified,
   * not assumed: `themeSource` read back "dark" and `shouldUseDarkColors` true
   * while the renderer's media query still said light. So the answer travels
   * over IPC, and `onThemeChange` carries later ones.
   */
  setTheme: (source: ThemeSource) => Promise<boolean>;
  /** Fires when the resolved theme changes, including from the OS. */
  onThemeChange: (listener: (dark: boolean) => void) => () => void;
  /** View › Toggle Sidebar (⌘B), and whatever else the View menu grows. */
  onViewCommand: (listener: (command: ViewCommand) => void) => () => void;
  /**
   * The page's zoom, as Electron holds it (1 is 100%).
   *
   * ⚠️ Asked of Electron, not worked out from `outerWidth / innerWidth`: the
   * two are updated at different moments while the window is resized, and the
   * ratio wobbled by a few percent on every step of a drag — which moved
   * everything placed by it.
   */
  zoomFactor: () => number;
  auth: DesktopAuthApi;
  workspaces: DesktopWorkspacesApi;
  git: DesktopGitApi;
  /** The project's local repository — changes, commits, history (FE-22). */
  worktree: DesktopWorktreeApi;
  terminal: DesktopTerminalApi;
  /** A Claude conversation as a chat, and its composer (FE-62). */
  conversation: DesktopConversationApi;
  /** Speech to text for the composer, on the Mac (FE-69). */
  dictation: DesktopDictationApi;
  /** Settings → Agents: the checkpoint hook for Claude Code (FE-28). */
  handoff: DesktopHandoffApi;
  /** Whether a project's folder is ready for an agent to work its board (FE-30). */
  readiness: DesktopReadinessApi;
  harness: DesktopHarnessApi;
  /** What Claude Code remembers about a project, read-only (FE-36). */
  memory: DesktopMemoryApi;
  /** What a project's agents are told, read-only (FE-37). */
  instructions: DesktopInstructionsApi;
  /** What Claude Code and Codex load in a project's folder, read-only (FE-40). */
  agentSetup: DesktopAgentSetupApi;
  /** The user's own Claude Code and Codex config files, edited (FE-47). */
  agentConfig: DesktopAgentConfigApi;
  /** The `lanework` MCP entry in Claude Code and Codex, local or cloud (FE-52/D8). */
  laneworkMcp: DesktopLaneworkMcpApi;
}
