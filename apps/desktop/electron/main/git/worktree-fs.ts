// Explicit changes to the Files tree, without invoking git.
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
  win32,
} from "node:path";

/** A relative tree path, with the directory marker removed. */
function treePath(value: string, allowRoot = false): string {
  if (allowRoot && (value === "" || value === "/")) return "";
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    throw new Error("Choose a relative path inside this repository.");
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("A file or folder name cannot be empty, '.' or '..'.");
  if (parts.some((part) => part.toLowerCase() === ".git"))
    throw new Error("Lanework cannot change .git or anything inside it.");
  return parts.join("/");
}

/** Refuse both an escape and a symlink alias into repository metadata. */
function assertInside(root: string, full: string): void {
  const path = relative(root, full);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("That path leaves this repository.");
  if (path.split(sep).some((part) => part.toLowerCase() === ".git"))
    throw new Error("Lanework cannot change .git or anything inside it.");
}

/**
 * Resolve the parent, keeping the leaf itself intact.
 *
 * NOTE: Moving a symlink moves the link, never its referent. Resolving its
 * parent still refuses writes through a directory link outside the root.
 */
async function entryAt(root: string, path: string): Promise<string> {
  const full = join(root, path);
  assertInside(root, full);
  const parent = await realpath(dirname(full)).catch(() => null);
  if (!parent) throw new Error(`The parent folder of "${path}" is not there.`);
  assertInside(root, parent);
  return join(parent, basename(full));
}

/** lstat also counts a dangling symlink as an existing destination. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One leaf only: mkdir never creates missing parents or replaces an entry. */
export async function makeDirectory(top: string, value: string): Promise<void> {
  const path = treePath(value);
  const root = await realpath(top);
  const full = await entryAt(root, path);
  try {
    await mkdir(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`"${path}" already exists. Choose another folder name.`);
    throw new Error(`Could not create "${path}": ${(error as Error).message}`);
  }
}

/** Permanently remove an entry, keeping a symlink's target intact. */
export async function removeEntry(top: string, value: string): Promise<void> {
  const path = treePath(value);
  const root = await realpath(top);
  const full = await entryAt(root, path);
  if (full === root)
    throw new Error("Lanework cannot delete the repository root.");
  const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new Error(`"${path}" is not there any more.`);
    throw error;
  });
  const isDirectory = info.isDirectory();
  if (value.endsWith("/") && !isDirectory)
    throw new Error(`"${path}" is not a folder.`);
  try {
    if (isDirectory) await rm(full, { recursive: true, force: false });
    else await unlink(full);
  } catch (error) {
    throw new Error(`Could not delete "${path}": ${(error as Error).message}`);
  }
}

/** Whether a canonical path names another path or something beneath it. */
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

/**
 * Validate the entire selection before renaming anything.
 *
 * NOTE: This is a preflight, not a transaction: an OS error during rename
 * can still leave earlier moves performed. Existing targets are never
 * deliberately overwritten, including dangling symlinks.
 */
export async function moveEntries(
  top: string,
  values: string[],
  toDir: string,
): Promise<{ moved: { from: string; to: string }[] }> {
  const root = await realpath(top);
  const destination = treePath(toDir, true);
  const directory = await realpath(join(root, destination)).catch(() => null);
  if (!directory) throw new Error("The destination folder is not there.");
  assertInside(root, directory);
  if (!(await stat(directory)).isDirectory())
    throw new Error("Choose a folder as the destination.");

  const entries: {
    full: string;
    target: string;
    directory: boolean;
    from: string;
    to: string;
  }[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const value of values) {
    const path = treePath(value);
    const full = await entryAt(root, path);
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(`"${path}" is not there any more.`);
      throw error;
    });
    const isDirectory = info.isDirectory();
    if (value.endsWith("/") && !isDirectory)
      throw new Error(`"${path}" is not a folder.`);
    if (isDirectory && contains(full, directory))
      throw new Error(
        `Cannot move "${path}" into itself or one of its folders.`,
      );
    const target = join(directory, basename(full));
    assertInside(root, target);
    // Same parent, including a different symlink spelling: nothing to do.
    if (full === target || sources.has(full)) continue;
    sources.add(full);
    if (targets.has(target) || (await exists(target)))
      throw new Error(
        `"${basename(full)}" already exists in the destination folder.`,
      );
    targets.add(target);
    const marker = isDirectory ? "/" : "";
    entries.push({
      full,
      target,
      directory: isDirectory,
      from: `${path}${marker}`,
      to: `${destination ? `${destination}/` : ""}${basename(full)}${marker}`,
    });
  }
  // A parent and child cannot both be renamed independently in one batch.
  for (const entry of entries) {
    if (
      entry.directory &&
      entries.some(
        (other) => other !== entry && contains(entry.full, other.full),
      )
    )
      throw new Error(
        "Choose either a folder or its contents to move, not both.",
      );
  }

  const moved: { from: string; to: string }[] = [];
  for (const entry of entries) {
    // Recheck immediately before rename in case the destination changed.
    if (await exists(entry.target))
      throw new Error(
        `"${basename(entry.target)}" already exists in the destination folder.`,
      );
    try {
      await rename(entry.full, entry.target);
    } catch (error) {
      throw new Error(
        `Could not move "${entry.from}": ${(error as Error).message}`,
      );
    }
    moved.push({ from: entry.from, to: entry.to });
  }
  return { moved };
}
