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
