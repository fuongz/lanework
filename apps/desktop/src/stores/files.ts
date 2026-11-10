import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { readStored, writeStored } from "#/lib/stored";
import { desktopSurface } from "#/server/desktop";
import type {
  FileListing,
  FileView,
  WorktreeState,
} from "../../shared/worktree";

/**
 * Repository › Files: the working tree, and the files open in tabs beside it.
 *
 * Read on entry, on window focus and on request. Never on a timer and never
 * by a file watcher, the same rule as Changes (FE-22/D10).
 *
 * NOTE: Mostly read-only (FE-66/D1). The tree can make a folder, move
 * entries and delete one (`worktree.mkdir`, `worktree.move`,
 * `worktree.remove`); this store only learns what they did
 * ({@link FilesStore.addDir}, {@link FilesStore.applyMove},
 * {@link FilesStore.applyRemove}).
 */

/**
 * One open file.
 *
 * A `preview` tab is the one a single click opens: the next single click
 * replaces it, the way an editor's italic tab does (FE-66/D3).
 */
interface FileTab {
  path: string;
  preview: boolean;
}

/**
 * The open tabs of each project and folder, kept across a switch.
 *
 * Coming back to one finds its files still open. Keyed `slug#folder`: two
 * folders' paths are never the same files.
 */
const tabMemory = new Map<string, { tabs: FileTab[]; active: string | null }>();
const memoryKey = (slug: string, folder: number) => `${slug}#${folder}`;

/** The empty folders made or emptied here, per project and folder. */
const madeMemory = new Map<string, string[]>();

/** The folder a tree path sits in: `a/b/` for `a/b/c` or `a/b/c/`; `''` at the top. */
export function parentDir(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? "" : trimmed.slice(0, at + 1);
}

/** The folders a file listing has a file in, at any depth. */
function filedFolders(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    if (path.endsWith("/")) continue;
    for (let dir = parentDir(path); dir; dir = parentDir(dir)) {
      if (out.has(dir)) break;
      out.add(dir);
    }
  }
  return out;
}

/** One entry moved: tree paths, a folder's keeping its trailing `/`. */
export interface MovedPath {
  from: string;
  to: string;
}

/**
 * Where `path` is after `moves`: the entry itself, or anything inside a
 * moved folder. Any other path comes back as it was.
 */
export function movedPath(path: string, moves: readonly MovedPath[]): string {
  for (const { from, to } of moves) {
    if (path === from) return to;
    if (from.endsWith("/") && path.startsWith(from))
      return `${to}${path.slice(from.length)}`;
  }
  return path;
}

/** Whether `path` is `removed` or, for a removed folder, anything inside it. */
export function removedPath(path: string, removed: string): boolean {
  return (
    path === removed || (removed.endsWith("/") && path.startsWith(removed))
  );
}

/** A record keyed by path, without the keys `gone` names. */
function dropKeys<T>(
  record: Record<string, T>,
  gone: (path: string) => boolean,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [path, value] of Object.entries(record))
    if (!gone(path)) out[path] = value;
  return out;
}

/** A listing without the paths `gone` names. */
function dropListing(
  listing: FileListing,
  gone: (path: string) => boolean,
): FileListing {
  const keep = (paths: string[]) => paths.filter((path) => !gone(path));
  return {
    ...listing,
    paths: keep(listing.paths),
    lazy: keep(listing.lazy),
    ignored: keep(listing.ignored),
  };
}

/** A record keyed by path, with its keys moved. */
function moveKeys<T>(
  record: Record<string, T>,
  moves: readonly MovedPath[],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [path, value] of Object.entries(record))
    out[movedPath(path, moves)] = value;
  return out;
}

/** A listing with every path in it moved. */
function moveListing(
  listing: FileListing,
  moves: readonly MovedPath[],
): FileListing {
  const move = (paths: string[]) => paths.map((p) => movedPath(p, moves));
  return {
    ...listing,
    paths: move(listing.paths),
    lazy: move(listing.lazy),
    ignored: move(listing.ignored),
  };
}

/**
 * The storage key of the folder Files last showed, per project.
 *
 * Saved by its path (FE-71/D4): an index would point at a different folder
 * once one before it is removed. A path no longer linked falls back to the
 * primary.
 */
const FOLDER_KEY = "lanework:files-folder";

function readSavedFolders(): Record<string, string> {
  try {
    const raw = readStored(FOLDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function savedFolder(slug: string): string | null {
  const path = readSavedFolders()[slug];
  return typeof path === "string" ? path : null;
}

export function saveFolder(slug: string, path: string | null): void {
  const { [slug]: _, ...rest } = readSavedFolders();
  // Remembering is a convenience; the switch already happened.
  writeStored(
    FOLDER_KEY,
    JSON.stringify(path ? { ...rest, [slug]: path } : rest),
  );
}

/**
 * The request ticket for folder reads.
 *
 * A slow answer about one project must not land on another, or on a later
 * read.
 */
let ticket = 0;

/** Directories being read right now, so opening one twice reads it once. */
const reading = new Set<string>();

interface FilesStore {
  slug: string | null;
  /** Which linked folder is on screen, by index; 0 is the primary. */
  folder: number;
  /**
   * `git status` of a non-primary folder; null for the primary.
   *
   * Read here because the worktree store holds the primary's, which Changes
   * and the rail read (FE-71/D1).
   */
  folderStatus: WorktreeState | null;
  /** The top read: git's list, ignored folders unread. */
  base: FileListing | null;
  /** Directories read since, by their path (`node_modules/`). */
  loaded: Record<string, FileListing>;
  /**
   * Folders known to be on disk that git's list cannot show.
   *
   * `ls-files` prints files, so an empty folder (one just made, or one a
   * move just emptied) is not in `base`. These are drawn with it until the
   * project is closed; a refresh drops the ones gone from their parent.
   */
  madeDirs: string[];
  loading: boolean;
  error: string | null;
  tabs: FileTab[];
  active: string | null;
  views: Record<string, FileView>;
  viewErrors: Record<string, string>;
  /**
   * Markdown files showing the rendered page rather than the source
   * (FE-66/D9).
   */
  rendered: Record<string, boolean>;
  quickOpen: boolean;

  open: (slug: string, folder?: number) => Promise<void>;
  refresh: () => Promise<void>;
  loadDir: (dir: string) => Promise<void>;
  /** A folder `worktree.mkdir` has just made (`a/b/`), drawn until git lists it. */
  addDir: (dir: string) => void;
  /**
   * Entries `worktree.move` has just moved: the listings, the tabs, the file
   * on screen and what was read for them follow, so an open file stays open
   * on its new path. Changes nothing on disk and reads nothing; `refresh`
   * after it reads the truth.
   */
  applyMove: (moves: readonly MovedPath[]) => void;
  /**
   * An entry `worktree.remove` has just deleted: a file, or a folder (`a/`)
   * and everything in it. It leaves the listings, the made folders and what
   * was read for it, and its tabs close. Changes nothing on disk and reads
   * nothing; `refresh` after it reads the truth.
   */
  applyRemove: (path: string) => void;
  /**
   * Open a file in a tab.
   *
   * @param pin Keep the tab (a double click, Quick Open). Without it, the
   * file opens in the preview tab, as a single click does.
   */
  openFile: (path: string, pin?: boolean) => void;
  /**
   * Open a repository path from another screen, such as a chat badge.
   *
   * It opens in a kept tab, switching to its project first. The caller then
   * navigates to Files.
   */
  reveal: (slug: string, path: string) => void;
  pin: (path: string) => void;
  close: (path: string) => void;
  activate: (path: string) => void;
  toggleRendered: (path: string) => void;
  setQuickOpen: (open: boolean) => void;
}

export const useFiles = create<FilesStore>((set, get) => {
  async function readView(slug: string, path: string): Promise<void> {
    const folder = get().folder;
    try {
      const view = await desktopSurface("worktree").view(slug, path, folder);
      if (get().slug !== slug || get().folder !== folder) return;
      set((state) => {
        const { [path]: _, ...viewErrors } = state.viewErrors;
        return { views: { ...state.views, [path]: view }, viewErrors };
      });
    } catch (error) {
      if (get().slug !== slug || get().folder !== folder) return;
      set((state) => ({
        viewErrors: {
          ...state.viewErrors,
          [path]: ipcMessage(error, "This file could not be read."),
        },
      }));
    }
  }

  function remember() {
    const { slug, folder, tabs, active, madeDirs } = get();
    if (!slug) return;
    tabMemory.set(memoryKey(slug, folder), { tabs, active });
    madeMemory.set(memoryKey(slug, folder), madeDirs);
  }

  /**
   * The made folders still in their parent folder.
   *
   * NOTE: One at the top is kept: the top cannot be read with `dir`, and
   * git's list says nothing about an empty folder.
   */
  async function stillMade(
    slug: string,
    folder: number,
    made: string[],
  ): Promise<string[]> {
    const byParent = new Map<string, string[]>();
    for (const dir of made) {
      const parent = parentDir(dir);
      byParent.set(parent, [...(byParent.get(parent) ?? []), dir]);
    }
    const kept = await Promise.all(
      [...byParent].map(async ([parent, dirs]) => {
        if (!parent) return dirs;
        const listing = await desktopSurface("worktree")
          .dir(slug, parent, folder)
          .catch(() => null);
        if (!listing) return dirs;
        const there = new Set(listing.paths);
        return dirs.filter((dir) => there.has(dir));
      }),
    );
    return kept.flat();
  }

  /**
   * Put `slug`'s `folder` on screen, with the tabs it had last time.
   *
   * @param folder The linked folder's index; 0 is the primary.
   */
  function switchTo(slug: string, folder: number) {
    if (get().slug === slug && get().folder === folder) return;
    remember();
    const kept = tabMemory.get(memoryKey(slug, folder));
    reading.clear();
    set({
      slug,
      folder,
      folderStatus: null,
      base: null,
      loaded: {},
      madeDirs: madeMemory.get(memoryKey(slug, folder)) ?? [],
      error: null,
      tabs: kept?.tabs ?? [],
      active: kept?.active ?? null,
      views: {},
      viewErrors: {},
      rendered: {},
      quickOpen: false,
    });
  }

  return {
    slug: null,
    folder: 0,
    folderStatus: null,
    base: null,
    loaded: {},
    madeDirs: [],
    loading: false,
    error: null,
    tabs: [],
    active: null,
    views: {},
    viewErrors: {},
    rendered: {},
    quickOpen: false,

    open: async (slug, folder = 0) => {
      switchTo(slug, folder);
      await get().refresh();
    },

    refresh: async () => {
      const { slug, folder } = get();
      if (!slug) return;
      const mine = ++ticket;
      set({ loading: true });
      try {
        // A non-primary folder answers for itself whether it is a repository
        // at all; the primary's answer is the worktree store's.
        if (folder > 0) {
          const folderStatus = await desktopSurface("worktree")
            .status(slug, folder)
            .catch((error: unknown) => {
              // A folder that was not a repository and now cannot be read
              // (Init Git, then the git gate held the read back, FE-124)
              // shows the read error, not its stale empty state.
              if (
                mine === ticket &&
                get().slug === slug &&
                get().folderStatus?.kind !== "ready"
              )
                set({ folderStatus: null });
              throw error;
            });
          if (mine !== ticket || get().slug !== slug) return;
          set({ folderStatus });
          if (folderStatus.kind !== "ready") {
            set({ base: null, loaded: {}, loading: false, error: null });
            return;
          }
        }
        // The folders somebody opened are read again with the top, so a
        // refresh never folds `node_modules/` shut under them. One that has
        // gone since is dropped.
        const dirs = Object.keys(get().loaded);
        const made = get().madeDirs;
        const [base, madeDirs, ...again] = await Promise.all([
          desktopSurface("worktree").files(slug, folder),
          stillMade(slug, folder, made),
          ...dirs.map((dir) =>
            desktopSurface("worktree")
              .dir(slug, dir, folder)
              .catch(() => null),
          ),
        ]);
        if (mine !== ticket || get().slug !== slug) return;
        const loaded: Record<string, FileListing> = {};
        dirs.forEach((dir, index) => {
          const listing = again[index];
          if (listing) loaded[dir] = listing;
        });
        // A folder made while this read was out is not in its answer. One
        // git lists a file in needs no keeping: it shows anyway, and goes
        // when it is deleted.
        const since = get().madeDirs.filter((dir) => !made.includes(dir));
        const listed = filedFolders(base.paths);
        set({
          base,
          loaded,
          madeDirs: [...madeDirs, ...since].filter((dir) => !listed.has(dir)),
          loading: false,
          error: null,
        });
        remember();
      } catch (error) {
        if (mine !== ticket || get().slug !== slug) return;
        set({
          loading: false,
          error: ipcMessage(error, "The folder could not be read."),
        });
        return;
      }
      // Open files are read again too: coming back from an editor is when a
      // file on screen has changed underneath.
      for (const tab of get().tabs) void readView(slug, tab.path);
    },

    loadDir: async (dir) => {
      const { slug, folder } = get();
      if (!slug || get().loaded[dir] || reading.has(dir)) return;
      reading.add(dir);
      try {
        const listing = await desktopSurface("worktree").dir(slug, dir, folder);
        if (get().slug !== slug || get().folder !== folder) return;
        set((state) => ({ loaded: { ...state.loaded, [dir]: listing } }));
      } catch {
        // A folder that vanished or points out of the repository stays empty;
        // the tree is no place for an error banner per row.
      } finally {
        reading.delete(dir);
      }
    },

    addDir: (dir) => {
      if (get().madeDirs.includes(dir)) return;
      set((state) => ({ madeDirs: [...state.madeDirs, dir] }));
      remember();
    },

    applyMove: (moves) => {
      if (!moves.length) return;
      set((state) => {
        const loaded: Record<string, FileListing> = {};
        for (const [dir, listing] of Object.entries(state.loaded))
          loaded[movedPath(dir, moves)] = moveListing(listing, moves);
        // The folders moved out of stay on disk, perhaps empty now, which
        // git's list would no longer show.
        const left = moves
          .map(({ from }) => parentDir(from))
          .filter((dir) => dir !== "");
        const madeDirs = [
          ...new Set([
            ...state.madeDirs.map((dir) => movedPath(dir, moves)),
            ...left,
          ]),
        ];
        const seen = new Set<string>();
        const tabs: FileTab[] = [];
        for (const tab of state.tabs) {
          const path = movedPath(tab.path, moves);
          if (seen.has(path)) continue;
          seen.add(path);
          tabs.push({ ...tab, path });
        }
        return {
          base: state.base && moveListing(state.base, moves),
          loaded,
          madeDirs,
          tabs,
          active: state.active && movedPath(state.active, moves),
          views: moveKeys(state.views, moves),
          viewErrors: moveKeys(state.viewErrors, moves),
          rendered: moveKeys(state.rendered, moves),
        };
      });
      remember();
    },

    applyRemove: (removed) => {
      const gone = (path: string) => removedPath(path, removed);
      set((state) => {
        const loaded: Record<string, FileListing> = {};
        for (const [dir, listing] of Object.entries(state.loaded))
          if (!gone(dir)) loaded[dir] = dropListing(listing, gone);
        // The folder it was in stays on disk, perhaps empty now, which git's
        // list would no longer show.
        const parent = parentDir(removed);
        const madeDirs = [
          ...new Set([
            ...state.madeDirs.filter((dir) => !gone(dir)),
            ...(parent ? [parent] : []),
          ]),
        ];
        const tabs = state.tabs.filter((tab) => !gone(tab.path));
        // The file on screen went with it: the next tab still open to the
        // right takes its place, as `close` does, else the one before.
        let active = state.active;
        if (active !== null && gone(active)) {
          const at = state.tabs.findIndex((tab) => tab.path === active);
          const kept = (tab: FileTab) => !gone(tab.path);
          active =
            (state.tabs.slice(at + 1).find(kept) ?? tabs.at(-1))?.path ?? null;
        }
        return {
          base: state.base && dropListing(state.base, gone),
          loaded,
          madeDirs,
          tabs,
          active,
          views: dropKeys(state.views, gone),
          viewErrors: dropKeys(state.viewErrors, gone),
          rendered: dropKeys(state.rendered, gone),
        };
      });
      remember();
    },

    openFile: (path, pin = false) => {
      const slug = get().slug;
      if (!slug) return;
      const { tabs } = get();
      const existing = tabs.find((tab) => tab.path === path);
      if (existing) {
        set({
          active: path,
          tabs:
            pin && existing.preview
              ? tabs.map((tab) =>
                  tab.path === path ? { ...tab, preview: false } : tab,
                )
              : tabs,
        });
      } else {
        const tab = { path, preview: !pin };
        const at = tabs.findIndex((item) => item.preview);
        set({
          active: path,
          tabs:
            at === -1
              ? [...tabs, tab]
              : tabs.map((item, index) => (index === at ? tab : item)),
        });
      }
      remember();
      if (!get().views[path]) void readView(slug, path);
    },

    reveal: (slug, path) => {
      // A chat names a path in the primary's repository (`locate` reads it),
      // so the file opens there. The saved folder is cleared, or Files would
      // switch back to it on arrival.
      saveFolder(slug, null);
      switchTo(slug, 0);
      get().openFile(path, true);
    },

    pin: (path) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.path === path ? { ...tab, preview: false } : tab,
        ),
      }));
      remember();
    },

    close: (path) => {
      const { tabs, active } = get();
      const at = tabs.findIndex((tab) => tab.path === path);
      if (at === -1) return;
      const next = tabs.filter((tab) => tab.path !== path);
      // The neighbour to the right takes its place, as in an editor; the last
      // tab hands over to the one before it.
      const after =
        active === path
          ? (next[Math.min(at, next.length - 1)]?.path ?? null)
          : active;
      set((state) => {
        const { [path]: _, ...views } = state.views;
        return { tabs: next, active: after, views };
      });
      remember();
    },

    activate: (path) => {
      set({ active: path });
      remember();
    },

    toggleRendered: (path) =>
      set((state) => ({
        rendered: { ...state.rendered, [path]: !state.rendered[path] },
      })),

    setQuickOpen: (quickOpen) => set({ quickOpen }),
  };
});

/** Whether a path is Markdown, as far as the rendered view is concerned. */
export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}
