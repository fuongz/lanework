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
 * NOTE: Read-only (FE-66/D1). Nothing here writes to the folder.
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
    const { slug, folder, tabs, active } = get();
    if (slug) tabMemory.set(memoryKey(slug, folder), { tabs, active });
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
          const folderStatus = await desktopSurface("worktree").status(
            slug,
            folder,
          );
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
        const [base, ...again] = await Promise.all([
          desktopSurface("worktree").files(slug, folder),
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
        set({ base, loaded, loading: false, error: null });
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
