// Write scopes (FE-87): which files a worker may change.
//
// A scope is a project-relative path as `scopePath` normalised it: `.` is the
// whole checkout, a directory covers what is under it. Paths a CLI reports are
// resolved through symlinks first (the nearest part that exists), so an alias
// or a link never turns a scratch folder into a way into another worker's
// files.
//
// Nothing here imports Electron.

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** Whether `path` (project-relative, `/`-separated) is inside `scope`. */
export function inScope(scope: string, path: string): boolean {
  const root = scope.replace(/\/+$/, "") || ".";
  if (root === ".") return true;
  return path === root || path.startsWith(`${root}/`);
}

/** Whether `path` is inside any of `scopes`. */
export function inScopes(scopes: readonly string[], path: string): boolean {
  return scopes.some((scope) => inScope(scope, path));
}

/**
 * Paths that configure an agent, an editor or a git hook (FE-89/D7): a file
 * here runs code the next time someone opens the project, so a worker may
 * write one only when its scope names it. They match at any depth.
 */
export const AGENT_CONFIG_PATHS = [
  ".claude",
  ".codex",
  ".mcp.json",
  ".vscode",
  ".husky",
  ".lanework",
] as const;

/** Whether `path` (project-relative, `/`-separated) is or is under one. */
export function isAgentConfig(path: string): boolean {
  return path
    .split("/")
    .some((part) => (AGENT_CONFIG_PATHS as readonly string[]).includes(part));
}

/**
 * Whether a worker with `scopes` may change `path`: inside a scope, and,
 * for an agent config path, inside a scope that is not `.` and itself names
 * the config path (`.claude`, `.claude/settings.json`, `pkg/.husky`).
 */
export function mayWrite(scopes: readonly string[], path: string): boolean {
  if (!isAgentConfig(path)) return inScopes(scopes, path);
  return scopes.some((scope) => isAgentConfig(scope) && inScope(scope, path));
}

/** Whether two tasks' scopes share any file. */
export function scopesOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.some((left) =>
    b.some((right) => inScope(left, right) || inScope(right, left)),
  );
}

/**
 * `path` with every symlink in the part that exists resolved; the missing
 * rest appended as is.
 *
 * @throws When a missing part is a dangling symlink.
 */
export async function resolvedPath(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      // A link to nothing is not a new ordinary file.
      if (
        await lstat(existing).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`${path} goes through a dangling symlink`);
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`${path} cannot be resolved`);
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** `child` relative to `root` with `/`, or null when it is not inside it. */
export function within(root: string, child: string): string | null {
  if (child === root) return ".";
  const rel = relative(root, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Where a reported write lands. */
export type WriteCheck =
  | { ok: true; where: "scope" | "scratch" }
  | { ok: false; path: string };

/**
 * Check one path a worker reports writing.
 *
 * @param root The worker's worktree, resolved.
 * @param scratch The worker's scratch folder, resolved; null when none.
 * @param path Absolute, or relative to `root`.
 */
export async function checkWrite(
  root: string,
  scratch: string | null,
  scopes: readonly string[],
  path: string,
): Promise<WriteCheck> {
  const absolute = isAbsolute(path) ? path : join(root, path);
  let resolved: string;
  try {
    resolved = await resolvedPath(absolute);
  } catch {
    return { ok: false, path };
  }
  if (scratch && within(scratch, resolved) !== null)
    return { ok: true, where: "scratch" };
  const rel = within(root, resolved);
  if (rel === null) return { ok: false, path: resolved };
  if (rel === "." || rel === ".git" || rel.startsWith(".git/"))
    return { ok: false, path: rel };
  return mayWrite(scopes, rel)
    ? { ok: true, where: "scope" }
    : { ok: false, path: rel };
}

/**
 * Whether a path a read-only tool names is inside the worker's worktree or
 * scratch folder (FE-89/D6). Only then may Jev allow the read on its own;
 * a read anywhere else goes to the lead.
 *
 * @param path Absolute, or relative to `root`; null: the tool's default,
 *   its working directory, which is `root`.
 */
export async function readsInside(
  root: string,
  scratch: string | null,
  path: string | null,
): Promise<boolean> {
  if (path === null) return true;
  const absolute = isAbsolute(path) ? path : join(root, path);
  let resolved: string;
  try {
    resolved = await resolvedPath(absolute);
  } catch {
    return false;
  }
  if (scratch && within(scratch, resolved) !== null) return true;
  const rel = within(root, resolved);
  return rel !== null && rel !== ".git" && !rel.startsWith(".git/");
}
