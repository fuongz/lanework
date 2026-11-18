// Path scope for the kit (FE-152): every tool runs in one folder, and that
// folder must be one of the caller's allowed roots or under one.
//
// - Both sides are resolved with realpath, so a symlink that leads out of a
//   root is refused like the path it leads to.
// - The roots come from the caller, never from the request alone: the app's
//   socket passes the project's linked folders and the client's cwd,
//   a standalone `lwk` or MCP server passes its cwd.
// - A root that is the file-system root or the home folder itself is too
//   broad to search, and is refused.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { KitError } from "./errors";

/**
 * `path`'s real path, or null when it does not exist or cannot be read.
 *
 * @throws Never.
 */
async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether `path` is `root` or inside it; both already real. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether `path` (real) is too broad to be a root: `/` or the home folder. */
async function tooBroad(path: string): Promise<boolean> {
  if (parse(path).root === path) return true;
  const home = await real(homedir());
  return home !== null && home === path;
}

/**
 * The real paths of `roots` that exist and are folders, without duplicates.
 *
 * @throws {KitError} `invalid` when a root is not absolute.
 */
export async function realRoots(roots: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const root of roots) {
    if (!isAbsolute(root))
      throw new KitError("invalid", `A root must be an absolute path: ${root}`);
    const found = await real(root);
    if (!found) continue;
    const info = await stat(found).catch(() => null);
    if (info?.isDirectory() && !(await tooBroad(found))) out.add(found);
  }
  return [...out];
}

/**
 * The folder a tool runs in: `folder` (relative to `cwd` when relative), or
 * `cwd` when unset, as a real path that is one of `roots` or under one.
 *
 * @throws {KitError} `invalid` when `cwd` is not absolute; `not_found`
 *   when the folder does not exist or is not a folder; `scope` when it is
 *   outside every root, or no root is usable.
 */
export async function resolveFolder(
  folder: string | undefined,
  cwd: string,
  roots: readonly string[],
): Promise<string> {
  if (!isAbsolute(cwd))
    throw new KitError("invalid", "The working folder must be absolute.");
  const asked = resolve(cwd, folder ?? ".");
  const found = await real(asked);
  if (!found)
    throw new KitError("not_found", `That folder does not exist: ${asked}`);
  const info = await stat(found).catch(() => null);
  if (!info?.isDirectory())
    throw new KitError("not_found", `That is not a folder: ${asked}`);
  const allowed = await realRoots(roots);
  if (allowed.length === 0)
    throw new KitError(
      "scope",
      "No folder is open to search here. Run it inside a project folder.",
    );
  if (!allowed.some((root) => isWithin(root, found)))
    throw new KitError(
      "scope",
      `${asked} is outside this project's folders (${allowed.join(", ")}).`,
    );
  return found;
}
