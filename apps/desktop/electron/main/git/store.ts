import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appHomeDir } from "../paths";

/**
 * Delete what this app once stored about GitHub: the OAuth token, the
 * project-to-repo links and the cached pull-request lists.
 *
 * - `gh` owns the login now and the repo is read from the folder, so
 *   nothing in that folder is still read.
 * - Errors are ignored. A folder that is already gone, or cannot be
 *   removed, must not stop the app from starting.
 *
 * NOTE: removes all of `~/.lanew/git/`. Nothing else may write there,
 * including the worktree code in this folder, or this would delete it.
 */
export async function removeLegacyStore(): Promise<void> {
  await rm(join(appHomeDir(), "git"), { recursive: true, force: true }).catch(
    () => {},
  );
}
