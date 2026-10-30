import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The name of the app's home folder, in the one place it is named.
 *
 * Every path that derives from it follows a change here. Nothing else may
 * hardcode the folder.
 */
export const APP_HOME_NAME = ".lanew";

/**
 * Absolute path of the app home (`~/.lanew`).
 *
 * NOTE: `LANEWORK_HOME` is not a convenience. Tests isolate state with
 * `LANEWORK_TEST_USER_DATA`, which only moves `app.getPath("userData")`. A
 * fixed dotfolder under `$HOME` does not follow it, so without this override
 * a test run would write into the developer's real credential.
 */
export function appHomeDir(): string {
  return process.env.LANEWORK_HOME || join(homedir(), APP_HOME_NAME);
}

/**
 * The per-account project state under the app home (`<home>/projects`): the
 * selection, the linked folders, the board caches and the migration receipts
 * (`projects/store.ts`).
 *
 * Only main reads it. The checkpoint hook, the local MCP server, the control
 * CLI and the plugin never do.
 */
export function projectsDir(home = appHomeDir()): string {
  return join(home, "projects");
}

/** {@link projectsDir}'s name before projects were called projects. */
const LEGACY_PROJECTS_DIR_NAME = "workspaces";

/**
 * Move `<home>/workspaces` to `<home>/projects`, once (FE-107).
 *
 * Main calls it at startup, before anything reads {@link projectsDir}. It
 * moves the folder only when `projects` does not exist yet and `workspaces`
 * does; otherwise it does nothing, so every later launch is a no-op.
 *
 * NOTE: A rename, not a copy: one atomic step on the same disk, with nothing
 * half-moved left behind. When it fails anyway (another launch moved it first,
 * a permissions problem), the app starts on whatever `projects` holds. That
 * costs the remembered selection and linked folders, never the cloud boards,
 * and starting at all matters more.
 *
 * @returns Whether the folder was moved.
 */
export function moveLegacyProjectsDir(home = appHomeDir()): boolean {
  const target = projectsDir(home);
  const legacy = join(home, LEGACY_PROJECTS_DIR_NAME);
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    renameSync(legacy, target);
    return true;
  } catch (error) {
    console.error(`Could not move ${legacy} to ${target}`, error);
    return false;
  }
}
