// A project's Claude memory, read off the disk: the folder Claude keeps it
// in, what each file says it is, and a watch on the folder.
//
// NOTE: Read-only, and nothing here imports Electron. Main calls it, and a
// spec drives it under plain Node against a fake home folder.
import { type FSWatcher, watch } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  isMemoryFile,
  MEMORY_INDEX,
  type MemoryEntry,
  type MemoryFile,
  memoryType,
} from "../../../shared/memory";
import { gitReadOut } from "../git/runner";
import { readsAllowed } from "../git/trust-gate";
import { claudeProjectDir, readRange } from "../terminal/agent-sessions";

/** The most of one memory a read takes. Claude's are a few KB. */
export const MEMORY_READ_MAX = 256 * 1024;
/** The most files one listing takes. */
const MEMORY_LIST_MAX = 500;
/** How much of each file a listing reads to find its frontmatter. */
const HEAD = 8 * 1024;
/** How much of the index a listing reads for titles. Claude loads 25 KB. */
const INDEX_MAX = 64 * 1024;
/** How long after a write the folder is reported, so a burst is one change. */
const SETTLE_MS = 300;

/**
 * The folder Claude names a project's memory by: its repository's.
 *
 * NOTE: Claude derives it from the git repository, so every subfolder and
 * every worktree of one repo shares one memory folder. Outside a repository
 * it is the folder itself. `--git-common-dir` gives the repository's own
 * `.git` from a worktree too, where `--show-toplevel` would give the
 * worktree's. Through the runner's read flags, so no hook or fsmonitor of
 * the repository runs (FE-77/D1). An automatic read (D6): a folder whose git
 * config the user has not trusted reads as if it were no repository.
 */
export async function memoryRoot(folder: string): Promise<string> {
  try {
    if (!(await readsAllowed(folder))) return folder;
    const stdout = await gitReadOut(folder, ["rev-parse", "--git-common-dir"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const common = resolve(folder, stdout.trim());
    // A bare repository's or a submodule's git folder is not named `.git`:
    // there is no working tree to name the memory by.
    if (stdout.trim() && basename(common) === ".git") return dirname(common);
  } catch {
    // Not a repository, or no git on PATH.
  }
  return folder;
}

/** The memory folder of `folder`, under Claude's home `claudeHome`. */
export async function memoryDir(
  claudeHome: string,
  folder: string,
): Promise<string> {
  return join(
    claudeHome,
    "projects",
    claudeProjectDir(await memoryRoot(folder)),
    "memory",
  );
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/**
 * The YAML a memory's frontmatter holds, as far as Claude writes it.
 *
 * `key: value`, and one level under a `parent:` read as `parent.child`. This
 * is not a YAML parser: anything else (a list, a block scalar, deeper
 * nesting) is skipped, not guessed at. The Raw view still shows it as
 * written.
 */
function parseFrontmatter(source: string): Record<string, string> {
  const meta: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const match = /^([ \t]*)([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!match) continue;
    const [, indent, key, value = ""] = match;
    if (!indent) {
      parent = value.trim() ? null : key;
      if (value.trim()) meta[key] = unquote(value);
    } else if (parent && value.trim())
      meta[`${parent}.${key}`] = unquote(value);
  }
  return meta;
}

/** A file's frontmatter (`---` … `---` at its very top), and the rest. */
function splitFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const source = text.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    source,
  );
  if (!match) return { meta: {}, body: source };
  return {
    meta: parseFrontmatter(match[1] ?? ""),
    body: source.slice(match[0].length).replace(/^\s*\n/, ""),
  };
}

function entryOf(
  file: string,
  meta: Record<string, string>,
  info: { mtimeMs: number; size: number },
): MemoryEntry {
  const stamp = meta["metadata.modified"] ?? meta.modified;
  const modified =
    stamp && Number.isFinite(Date.parse(stamp))
      ? new Date(stamp).toISOString()
      : new Date(info.mtimeMs).toISOString();
  return {
    file,
    name: meta.name?.trim() || file.replace(/\.md$/, ""),
    description: meta.description?.trim() || null,
    type: memoryType(meta.type ?? meta["metadata.type"]),
    title: null,
    modified,
    mtimeMs: info.mtimeMs,
    size: info.size,
  };
}

/**
 * The title `MEMORY.md` gives each memory it links to.
 *
 * A link reads `[Title](file.md)`, and the first link to a file wins. A link
 * to anything that is not a memory in the same folder names nothing.
 */
function indexTitles(index: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const match of index.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const title = match[1]?.trim();
    const file = match[2]?.replace(/^\.\//, "");
    if (title && isMemoryFile(file) && !titles.has(file))
      titles.set(file, title);
  }
  return titles;
}

/**
 * Where `file` in `dir` really is.
 *
 * NOTE: Its real path must be directly inside the folder's real path. A link
 * that leads out of it, or into a folder below it, is refused.
 *
 * @throws When `file` is not a memory file name, or is not directly inside.
 */
async function inside(dir: string, file: string): Promise<string> {
  if (!isMemoryFile(file)) throw new Error("That is not a memory file.");
  const refused = new Error("That memory is not in this project's folder.");
  const [root, path] = await Promise.all([
    realpath(dir),
    realpath(join(dir, file)),
  ]).catch(() => {
    throw refused;
  });
  const within = relative(root, path);
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    basename(within) !== within
  )
    throw refused;
  return path;
}

/**
 * Every memory in `dir`, by what its frontmatter says it is.
 *
 * Only `.md` files directly in it: Claude's memory is flat, and nothing else
 * in the folder is a memory.
 *
 * @returns Null when Claude has not made the folder.
 */
export async function listMemory(
  dir: string,
): Promise<{ entries: MemoryEntry[]; truncated: boolean } | null> {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!names) return null;
  const files = names
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) && isMemoryFile(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const read = await Promise.all(
    files.slice(0, MEMORY_LIST_MAX).map(async (file) => {
      try {
        const path = await inside(dir, file);
        const info = await stat(path);
        if (!info.isFile()) return null;
        const head = await readRange(path, 0, Math.min(info.size, HEAD));
        return entryOf(file, splitFrontmatter(head).meta, info);
      } catch {
        // Gone since the listing, or a link out of the folder.
        return null;
      }
    }),
  );
  const entries = read.filter((entry): entry is MemoryEntry => entry !== null);
  // Titled as the index names them: a memory's `name` is often its slug, and
  // the index is where Claude wrote the words a person reads.
  const index = entries.find((entry) => entry.file === MEMORY_INDEX);
  const titles = index
    ? indexTitles(
        await inside(dir, MEMORY_INDEX)
          .then((path) => readRange(path, 0, Math.min(index.size, INDEX_MAX)))
          .catch(() => ""),
      )
    : new Map<string, string>();
  return {
    entries: entries.map((entry) => ({
      ...entry,
      title: titles.get(entry.file) ?? null,
    })),
    truncated: files.length > MEMORY_LIST_MAX,
  };
}

/**
 * Memory `file` in `dir` for the viewer, at most `MEMORY_READ_MAX` of it.
 *
 * @throws When the file is not a memory directly in `dir`, or not a file.
 */
export async function readMemory(
  dir: string,
  file: string,
): Promise<MemoryFile> {
  const path = await inside(dir, file);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("That memory is not a file.");
  const raw = await readRange(path, 0, Math.min(info.size, MEMORY_READ_MAX));
  const { meta, body } = splitFrontmatter(raw);
  return {
    entry: entryOf(file, meta, info),
    meta,
    body,
    raw,
    truncated: info.size > MEMORY_READ_MAX,
  };
}

/**
 * Call `onChange` when anything in `dir` is written (FE-36/D11).
 *
 * A burst of writes calls it once. A folder Claude has not made yet is waited
 * for in its parent, the project's conversations folder, and watched from the
 * moment it appears. With no parent either, nothing is watched, and the next
 * listing starts again.
 *
 * @returns A function that stops the watch.
 */
export function watchMemory(dir: string, onChange: () => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const changed = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, SETTLE_MS);
  };
  const close = () => {
    watcher?.close();
    watcher = null;
  };
  const follow = (): boolean => {
    try {
      watcher = watch(dir, changed);
      // The folder was removed under the watch: report a change, and the
      // next listing starts again.
      watcher.on("error", () => {
        close();
        changed();
      });
      return true;
    } catch {
      return false;
    }
  };
  if (!follow()) {
    try {
      watcher = watch(dirname(dir), (_event, name) => {
        if (name === null || String(name) !== basename(dir)) return;
        close();
        if (follow()) changed();
      });
      watcher.on("error", close);
    } catch {
      // No conversations in this folder either.
    }
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    close();
  };
}
