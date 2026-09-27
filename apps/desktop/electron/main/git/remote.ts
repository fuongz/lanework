import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRepoRef, type RepoRef } from "../../../shared/git";

const run = promisify(execFile);

/**
 * What a folder's `origin` remote points at, as a suggestion.
 *
 * ⚠️ A SUGGESTION, never a link. This app offers what it found and a human
 * confirms it; a project that attached itself to whatever remote a folder
 * happened to carry would eventually show somebody another team's pull
 * requests, with nothing on screen explaining where they came from.
 *
 * ⚠️ Read-only, like every other reader of a user's folder in this app. `git
 * remote get-url` reads `.git/config` and changes nothing. Nothing here may
 * grow a command that writes.
 *
 * ⚠️ `execFile`, not `exec`: no shell is involved, so a folder name with a
 * space, a quote or a `;` in it is an argument rather than syntax.
 */
export async function suggestRepo(
  folder: string | null,
): Promise<RepoRef | null> {
  const url = await originUrl(folder);
  return url === null ? null : parseRepoRef(url);
}

/**
 * `git remote get-url origin` in `folder`, as git prints it, or null.
 *
 * Any host, not only GitHub: the readiness check (FE-30) hands it to the
 * service, which decides what it can link.
 */
export async function originUrl(folder: string | null): Promise<string | null> {
  if (!folder) return null;
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], {
      cwd: folder,
      timeout: 5_000,
      windowsHide: true,
      // A remote URL is one line. Anything beyond this is not one.
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    // Not a git repo, no `origin`, no `git` on PATH, or the folder is gone.
    // None of those is an error worth a dialog: the user types the repo instead.
    return null;
  }
}
