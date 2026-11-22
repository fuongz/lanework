// Explicit changes to the Files tree, without invoking git.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
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
import {
  type FileVersion,
  type FileWriteResult,
  MAX_TEXT_FILE_BYTES,
} from "../../../shared/worktree";
import { fileVersion, sameVersion, textSnapshot } from "./worktree-content";

/** Serialize saves to the same canonical file, including symlink aliases. */
const saves = new Map<string, Promise<unknown>>();

/** Resolve a leaf symlink too: edits save its referent and keep the link. */
async function writeTarget(root: string, path: string): Promise<string> {
  const entry = await entryAt(root, path);
  const info = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return entry;
  const target = await realpath(entry);
  assertInside(root, target);
  return target;
}

/** Atomic, bounded UTF-8 saves with optimistic version checking. */
export async function writeFile(
  top: string,
  value: string,
  text: string,
  expected: FileVersion | null,
): Promise<FileWriteResult> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_TEXT_FILE_BYTES)
    return {
      kind: "error",
      reason: "too-large",
      message: "Text files must be at most 2 MB.",
    };
  if (bytes.includes(0))
    return {
      kind: "error",
      reason: "binary",
      message: "Text files cannot contain NUL bytes.",
    };
  if (bytes.toString("utf8") !== text)
    return {
      kind: "error",
      reason: "invalid-text",
      message: "The text contains invalid Unicode.",
    };
  const path = treePath(value);
  const root = await realpath(top);
  // A removed parent also means the file is missing. Never recreate it.
  if (expected !== null) {
    try {
      await realpath(dirname(join(root, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { kind: "missing" };
      throw error;
    }
  }
  const full = await writeTarget(root, path);
  const previous = saves.get(full) ?? Promise.resolve();
  const saving = previous
    .catch(() => {})
    .then(async (): Promise<FileWriteResult> => {
      const inspect = async () => {
        if ((await writeTarget(root, path)) !== full)
          throw new Error(
            "The file's symlink target changed. Open the file again.",
          );
        const handle = await open(
          full,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!handle) return null;
        try {
          return await textSnapshot(handle);
        } finally {
          await handle.close();
        }
      };
      const check = (
        disk: Awaited<ReturnType<typeof inspect>>,
      ): FileWriteResult | null => {
        if (disk?.kind === "error") return disk;
        if (!disk) return expected === null ? null : { kind: "missing" };
        if (expected && !sameVersion(expected, disk.version))
          return { kind: "conflict", text: disk.text, version: disk.version };
        return null;
      };
      const disk = await inspect();
      const refused = check(disk);
      if (refused) return refused;
      const temporary = join(dirname(full), `.lanework-save-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        // Recheck after the asynchronous write, before replacing the file.
        const latest = await inspect();
        const changed = check(latest);
        if (changed) return changed;
        if (latest?.kind === "text") await handle.chmod(latest.mode & 0o7777);
        else await handle.chmod(0o666 & ~process.umask());
        await handle.sync();
        const info = await handle.stat();
        await handle.close();
        await rename(temporary, full);
        return { kind: "saved", version: fileVersion(info.mtimeMs, bytes) };
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
      }
    });
  saves.set(full, saving);
  try {
    return await saving;
  } finally {
    if (saves.get(full) === saving) saves.delete(full);
  }
}

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
