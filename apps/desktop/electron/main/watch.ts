// One way for main to watch a folder or a file (FE-151): @parcel/watcher when
// it loads, node:fs `watch` when it does not.
//
// Event names, from each backend:
//
// | WatchEvent | @parcel/watcher | node:fs watch                              |
// | ---------- | --------------- | ------------------------------------------ |
// | `create`   | `create`        | `rename`, and the path is there afterwards |
// | `update`   | `update`        | `change`                                   |
// | `delete`   | `delete`        | `rename`, and the path is gone afterwards  |
//
// Every caller today reads only the NAME, as it did from fs.watch, so the
// type is a hint, never a promise: FSEvents folds a burst into one event and
// node:fs cannot tell a move in from a create.
import {
  existsSync,
  type FSWatcher,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  sep,
} from "node:path";
import { loadWatcher, type WatcherModule } from "./native";

export interface WatchEvent {
  type: "create" | "update" | "delete";
  /**
   * The path written, relative to the watched folder (a file's own watch:
   * its base name), as fs.watch names it. The watched folder itself is its
   * base name. Null when the OS did not say (node:fs only).
   */
  name: string | null;
  /** `name` joined to the path as given, or null with it. */
  path: string | null;
}

export interface WatchOptions {
  /** The whole tree, rather than the folder's own entries. */
  recursive?: boolean;
  /**
   * Paths relative to the folder, or globs, whose events are dropped. A path
   * drops everything under it too.
   */
  ignore?: string[];
  /** Called once when the watch fails. It is closed by then. */
  onError?: (error: Error) => void;
  /**
   * False: the node:fs fallback does not keep the process alive, as
   * `FSWatcher.unref()` did. @parcel/watcher's thread never does.
   */
  persistent?: boolean;
}

export interface Watch {
  /** Stops it. Safe to call twice, and before the watch is up. */
  close(): void;
}

/**
 * Watch `path` and call `onChange` with what was written, a batch at a time.
 *
 * A file is watched on its own, through node:fs, whichever backend loads.
 *
 * NOTE: Not through its folder, as @parcel/watcher would have it. On macOS
 * an FSEvents stream (parcel's, and node:fs's for a folder) says nothing of
 * the appends to a file a process keeps open until it closes it; Codex
 * appends to its rollouts that way. A file's own watch is kqueue, and sees
 * every write (FE-31).
 *
 * @returns The watch, or null when `path` is not there (yet): the caller
 *   waits for it, as it did on fs.watch's ENOENT. Never throws, and a throw
 *   from `onChange` is logged, not passed on.
 */
export function watchPath(
  path: string,
  options: WatchOptions,
  onChange: (events: WatchEvent[]) => void,
): Watch | null {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch {
    return null;
  }
  const ignored = ignoreFilter(options.ignore);
  const deliver = (events: WatchEvent[]) => {
    const kept = events.filter(
      (event) => event.name === null || !ignored(event.name),
    );
    if (kept.length === 0) return;
    try {
      onChange(kept);
    } catch (error) {
      console.error(`[watch] ${path}: a change handler threw`, error);
    }
  };
  const parcel = isFile ? null : loadWatcher();
  if (parcel) return parcelWatch(parcel, path, options, deliver);
  try {
    return fsWatch(path, isFile, options, deliver);
  } catch {
    // Gone between the stat and the watch.
    return null;
  }
}

/** True for a name `ignore` drops. */
function ignoreFilter(ignore: string[] | undefined): (name: string) => boolean {
  if (!ignore?.length) return () => false;
  const globs = ignore.filter((entry) => /[*?[{]/.test(entry));
  const paths = ignore
    .filter((entry) => !globs.includes(entry))
    .map((entry) => entry.replace(/[\\/]+$/, ""));
  return (name) =>
    paths.some((entry) => name === entry || name.startsWith(entry + sep)) ||
    globs.some((glob) => matchesGlob(name, glob));
}

/** The node:fs watch: `rename` read as create or delete by a look. */
function fsWatch(
  path: string,
  isFile: boolean,
  options: WatchOptions,
  deliver: (events: WatchEvent[]) => void,
): Watch {
  const root = isFile ? dirname(path) : path;
  let closed = false;
  const watcher: FSWatcher = watch(
    path,
    {
      recursive: !isFile && options.recursive === true,
      persistent: options.persistent !== false,
    },
    (event, file) => {
      if (closed) return;
      const name = file === null ? null : String(file);
      const full = name === null ? null : join(root, name);
      deliver([
        {
          type:
            event === "change"
              ? "update"
              : full !== null && existsSync(full)
                ? "create"
                : "delete",
          name,
          path: full,
        },
      ]);
    },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
  };
  watcher.on("error", (error) => {
    if (closed) return;
    close();
    options.onError?.(error);
  });
  return { close };
}

/**
 * @parcel/watcher's watch. It is always recursive: a plain watch keeps the
 * folder's own entries, and the folder itself.
 *
 * NOTE: `subscribe` is async. A close before it settles unsubscribes once it
 * does; a subscribe that fails falls back to node:fs.
 */
function parcelWatch(
  parcel: WatcherModule,
  path: string,
  options: WatchOptions,
  deliver: (events: WatchEvent[]) => void,
): Watch {
  // Its events carry the real path (`/private/tmp`, not `/tmp`).
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Gone already: subscribe fails, and the fallback says so.
  }
  let closed = false;
  let fallback: Watch | null = null;
  let unsubscribe: (() => Promise<void>) | null = null;
  const fail = (error: Error) => {
    if (closed) return;
    close();
    options.onError?.(error);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    fallback?.close();
    void unsubscribe?.().catch(() => undefined);
  };
  parcel
    .subscribe(
      path,
      (error, events) => {
        if (closed) return;
        if (error) return fail(error);
        const out: WatchEvent[] = [];
        for (const event of events) {
          const name =
            event.path === real ? basename(path) : relative(real, event.path);
          if (!name || name.startsWith("..") || isAbsolute(name)) continue;
          if (
            !options.recursive &&
            event.path !== real &&
            dirname(event.path) !== real
          )
            continue;
          out.push({
            type: event.type,
            name,
            path: event.path === real ? path : join(path, name),
          });
        }
        if (out.length > 0) deliver(out);
      },
      options.ignore?.length ? { ignore: options.ignore } : undefined,
    )
    .then(
      (subscription) => {
        unsubscribe = () => subscription.unsubscribe();
        if (closed) void unsubscribe().catch(() => undefined);
      },
      (error: unknown) => {
        if (closed) return;
        try {
          fallback = fsWatch(
            path,
            false,
            { ...options, onError: fail },
            (events) => {
              if (!closed) deliver(events);
            },
          );
        } catch {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  return { close };
}
