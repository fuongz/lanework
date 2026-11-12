import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEAD_REF_PATTERN } from "../../shared/orchestration";

/**
 * The name of the app's home folder, in the one place it is named.
 *
 * Every path that derives from it follows a change here. Nothing else may
 * hardcode the folder.
 */
export const APP_HOME_NAME = ".lanew";

/**
 * The Preview's app home folder (`channel.ts`): a packaged dev build keeps
 * its credential, boards and shims apart from the release's.
 */
export const PREVIEW_APP_HOME_NAME = ".lanew-preview";

/** The folder {@link appHomeDir} names: the release's until main says. */
let homeName = APP_HOME_NAME;

/**
 * Make {@link appHomeDir} the Preview's, `~/.lanew-preview`.
 *
 * Main calls it once, at startup, before anything reads the app home
 * (`applyChannel` in `channel.ts`). Electron-free on purpose: the local store,
 * the control CLI and the offline MCP server import this file in processes
 * with no Electron. Those get the Preview's home through the `LANEWORK_HOME`
 * their shim exports.
 */
export function selectPreviewAppHome(): void {
  homeName = PREVIEW_APP_HOME_NAME;
}

/**
 * Absolute path of the app home: `~/.lanew`, or `~/.lanew-preview` in the
 * Preview.
 *
 * NOTE: `LANEWORK_HOME` is not a convenience. Tests isolate state with
 * `LANEWORK_TEST_USER_DATA`, which only moves `app.getPath("userData")`. A
 * fixed dotfolder under `$HOME` does not follow it, so without this override
 * a test run would write into the developer's real credential. It wins over
 * the Preview's folder too.
 */
export function appHomeDir(): string {
  return process.env.LANEWORK_HOME || join(homedir(), homeName);
}

/**
 * Lanework's own record of agent conversations (FE-112): `<home>/lw.db`.
 *
 * What the rail lists, the names, pins and conductors given in Lanework, and
 * how far each CLI transcript has been read (`session-store/`). It follows
 * `LANEWORK_HOME` like every other app path.
 */
export function sessionStorePath(home = appHomeDir()): string {
  return join(home, "lw.db");
}

/**
 * The resource log (FE-115): `<home>/metrics`, one JSON-lines file per hour,
 * the last 24 kept (`metrics/log.ts`).
 */
export function metricsDir(home = appHomeDir()): string {
  return join(home, "metrics");
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

/**
 * A conductor's memory of one project (FE-128):
 * `<project folder>/conductors/<id>/memory.json`, beside the project's other
 * state.
 *
 * @param projectFolder The project's own folder under {@link projectsDir}
 *   (`<account>/<slug>`, as `projects/store.ts` names it).
 * @param conductorId A team lead's id, or `repo:` and one. The colon becomes
 *   a dot, which no lead id holds, so the folder name is safe on every disk
 *   and never one another conductor's id maps to.
 * @throws When `conductorId` is not a team lead's id.
 */
export function conductorMemoryFile(
  projectFolder: string,
  conductorId: string,
): string {
  if (!LEAD_REF_PATTERN.test(conductorId))
    throw new Error("That conductor id is not valid.");
  return join(
    projectFolder,
    "conductors",
    conductorId.replace(":", "."),
    "memory.json",
  );
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
