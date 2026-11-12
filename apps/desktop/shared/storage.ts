// Settings → Storage: how much disk Lanework takes, split into the parts a
// person can act on, and clearing the part that is only a cache.
//
// The cache is Chromium's: HTTP responses, V8's compiled code and GPU
// shaders. Clearing it loses nothing; the app reads or compiles it again.

/**
 * Where the bytes are, in the order the bar draws them.
 *
 * - `cache`: Chromium's caches in `userData`, what Clear cache empties.
 * - `checkouts`: the worktrees orchestration runs keep, under
 *   `userData/orchestration/worktrees`.
 * - `projects`: the app home (`~/.lanew`): boards, projects, the resource
 *   log.
 * - `app`: the rest of `userData`: settings, sign-in, run history.
 */
export const STORAGE_PARTS = ["cache", "checkouts", "projects", "app"] as const;
export type StoragePart = (typeof STORAGE_PARTS)[number];

/** Bytes on disk, as `du` counts them. */
export interface StorageUsage {
  /** Every part together. */
  total: number;
  parts: Record<StoragePart, number>;
}

/** The two folders Finder can open: `userData`, and the app home. */
export type StorageFolder = "app" | "projects";

export const storageChannels = {
  usage: "storage:usage",
  clearCache: "storage:clear-cache",
  /** Open a folder in Finder. */
  reveal: "storage:reveal",
} as const;

export interface DesktopStorageApi {
  usage: () => Promise<StorageUsage>;
  /** Clears the cache, then measures again. */
  clearCache: () => Promise<StorageUsage>;
  reveal: (folder: StorageFolder) => Promise<void>;
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Decimal units, as Finder counts: `1.5 GB`, `820 MB`, `0 KB`. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes) / 1000;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
