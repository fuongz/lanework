import type { DesktopAuthApi } from "./auth";
import type { DesktopGitApi } from "./git";
import type { DesktopWorkspacesApi } from "./workspaces";

export const channels = {
  appInfo: "app:get-info",
  setTheme: "app:set-theme",
  themeChanged: "app:theme-changed",
} as const;

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
  auth: DesktopAuthApi;
  workspaces: DesktopWorkspacesApi;
  git: DesktopGitApi;
}
