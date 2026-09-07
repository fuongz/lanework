import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one place the app's home folder is named. Change this and every path that
 * derives from it follows; nothing else may hardcode the folder.
 */
export const APP_HOME_NAME = ".lanew";

/**
 * Absolute path of the app home (`~/.lanew`).
 *
 * `LANEWORK_HOME` is not a convenience. Tests isolate state with
 * `LANEWORK_TEST_USER_DATA`, which only moves `app.getPath("userData")` — a
 * fixed dotfolder under `$HOME` does not follow it, so without this override a
 * test run would write into the developer's real credential.
 */
export function appHomeDir(): string {
  return process.env.LANEWORK_HOME || join(homedir(), APP_HOME_NAME);
}
