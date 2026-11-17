// fff's file finders, one per folder (FE-151). A finder indexes its folder
// once, honouring `.gitignore`, then keeps the index fresh with its own
// watcher, so a query costs a few milliseconds however big the folder is.
//
// - Created lazily, on a folder's first query, through `../native`.
// - At most {@link POOL_MAX} are kept, the least recently used dropped
//   first; one unused for {@link IDLE_MS} is dropped too.
// - Null whenever fff cannot answer yet (missing, refused the folder, still
//   scanning): the caller falls back to its own file list.
//
// NOTE: Nothing here imports Electron: `conversation/suggest.ts` uses it.
import type { FileFinder } from "@ff-labs/fff-node";
import type { FileHit } from "../../../shared/fs-search";
import { loadFff } from "../native";

/** The most finders kept at once. */
const POOL_MAX = 4;
/** A finder unused this long is destroyed. */
const IDLE_MS = 10 * 60_000;
/** How long the first scan may take before it counts as failed. */
const SCAN_MAX_MS = 60_000;
/** How long a query waits for a scan still running before falling back. */
const SCAN_WAIT_MS = 400;

interface Entry {
  finder: FileFinder;
  /** The first scan finished. */
  ready: boolean;
  /** Settles when the first scan finishes or times out. */
  scan: Promise<void>;
  idle: ReturnType<typeof setTimeout>;
}

/** The finders by absolute folder, least recently used first. */
const pool = new Map<string, Entry>();

/** Destroy `folder`'s finder, if there is one. */
export function closeFinder(folder: string): void {
  const entry = pool.get(folder);
  if (!entry) return;
  pool.delete(folder);
  clearTimeout(entry.idle);
  if (!entry.finder.isDestroyed) entry.finder.destroy();
}

/**
 * Destroy every finder, or those of `folders` only: when a project closes
 * or unlinks them, and at quit.
 */
export function closeFinders(folders?: Iterable<string>): void {
  for (const folder of folders ?? [...pool.keys()]) closeFinder(folder);
}

/** Restart `folder`'s idle timer. */
function idleTimer(folder: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => closeFinder(folder), IDLE_MS);
  timer.unref?.();
  return timer;
}

/** `folder`'s entry, created when it has none; null when fff cannot index it. */
function entryFor(folder: string): Entry | null {
  const found = pool.get(folder);
  if (found) {
    // Most recently used goes last.
    pool.delete(folder);
    clearTimeout(found.idle);
    found.idle = idleTimer(folder);
    pool.set(folder, found);
    return found;
  }
  const fff = loadFff();
  if (!fff) return null;
  const created = fff.FileFinder.create({
    basePath: folder,
    // Names only: content search is ripgrep's (FE-149).
    disableContentIndexing: true,
    disableMmapCache: true,
  });
  if (!created.ok) {
    console.warn(`[file-finder] fff cannot index a folder: ${created.error}`);
    return null;
  }
  const finder = created.value;
  const entry: Entry = {
    finder,
    ready: false,
    scan: Promise.resolve(),
    idle: idleTimer(folder),
  };
  entry.scan = finder
    .waitForScan(SCAN_MAX_MS)
    .then((done) => {
      entry.ready = done.ok && done.value;
    })
    .catch(() => {});
  pool.set(folder, entry);
  while (pool.size > POOL_MAX) closeFinder(pool.keys().next().value as string);
  return entry;
}

/**
 * `folder`'s finder, scanned, or null when fff cannot answer: not loaded
 * here, the folder refused, or its first scan still running after
 * {@link SCAN_WAIT_MS}.
 */
async function readyFinder(folder: string): Promise<FileFinder | null> {
  const entry = entryFor(folder);
  if (!entry) return null;
  if (!entry.ready) {
    // A scan past SCAN_MAX_MS may still finish.
    if (!entry.finder.isDestroyed && !entry.finder.isScanning())
      entry.ready = true;
    else
      await Promise.race([
        entry.scan,
        new Promise((resolve) => setTimeout(resolve, SCAN_WAIT_MS)),
      ]);
  }
  // Evicted or closed while waiting.
  if (!entry.ready || entry.finder.isDestroyed) return null;
  return entry.finder;
}

/** fff's relative path, `/`-separated. */
const slashed = (path: string) => path.replaceAll("\\", "/");

/**
 * The files of `folder` that fuzzily match `query`, best first, at most
 * `limit` of them.
 *
 * @returns null when fff cannot answer; the caller falls back.
 */
export async function findFiles(
  folder: string,
  query: string,
  limit: number,
): Promise<FileHit[] | null> {
  const finder = await readyFinder(folder);
  if (!finder) return null;
  const found = finder.fileSearch(query, { pageSize: limit });
  if (!found.ok) return null;
  const { items, scores } = found.value;
  return items.map((item, index) => ({
    path: slashed(item.relativePath),
    score: scores[index]?.total ?? 0,
  }));
}

/** A file or a folder (`a/b/`) that matched, from {@link findEntries}. */
export interface EntryHit {
  /** Relative to the folder, `/`-separated; a folder's ends in `/`. */
  path: string;
  kind: "file" | "folder";
}

/**
 * The files and folders of `folder` that fuzzily match `query`, best
 * first, at most `limit` of them.
 *
 * @returns null when fff cannot answer; the caller falls back.
 */
export async function findEntries(
  folder: string,
  query: string,
  limit: number,
): Promise<EntryHit[] | null> {
  const finder = await readyFinder(folder);
  if (!finder) return null;
  const found = finder.mixedSearch(query, { pageSize: limit });
  if (!found.ok) return null;
  const hits: EntryHit[] = [];
  for (const entry of found.value.items) {
    const path = slashed(entry.item.relativePath);
    // The folder itself is no suggestion.
    if (!path || path === "/" || path === "./") continue;
    hits.push({ path, kind: entry.type === "file" ? "file" : "folder" });
  }
  return hits;
}
