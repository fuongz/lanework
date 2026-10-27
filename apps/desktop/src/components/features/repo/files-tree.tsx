// The working tree, as a tree.
//
// - Lazy below what git ignores. The first read is git's list plus the
//   ignored folders as empty rows; opening `node_modules/` reads that one
//   folder, and each folder inside it waits for its own click.
//   `@pierre/trees` has no "load children" hook, so the tree is watched
//   (`subscribe`) for an unread folder that has just been expanded.
// - A web component with its own shadow root, styled through variables on
//   the host: see `treeHostStyle`.
import { RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  GitStatus,
  GitStatusEntry,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_TREE_ICONS,
  TREE_ICON_TINT_CSS,
} from "#/components/shared/diff/diff-icons";
import {
  COMPACT_TREE_STYLE,
  FOLDER_ICON_CSS,
  FOLDER_STATUS_CSS,
  parents,
  rollUpFolders,
  treeHostStyle,
} from "#/components/shared/diff/tree-style";
import { Button } from "#/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { useDark } from "#/hooks/use-dark";
import { useFiles } from "#/stores/files";
import {
  type FileListing,
  LAUNCHABLE,
  type WorktreeFile,
  type WorktreeFileStatus,
} from "../../../../shared/worktree";

/** Changes, in the tree's vocabulary (FE-66/D7). */
function toGitStatus(status: WorktreeFileStatus): GitStatus {
  switch (status) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "untracked":
      return "untracked";
    case "modified":
    case "conflicted":
      return "modified";
  }
}

/**
 * The handle when it is a folder.
 *
 * `isDirectory()` does not narrow the union.
 */
function folder(
  item: FileTreeItemHandle | null,
): FileTreeDirectoryHandle | null {
  return item?.isDirectory() ? (item as FileTreeDirectoryHandle) : null;
}

/** The tree row an event happened on; its path crosses the shadow root. */
function rowPath(event: Event): string | undefined {
  const row = event
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.itemPath !== undefined,
    );
  return row?.dataset.itemPath;
}

/** Every folder in a listing: the ones named and the ones paths sit in. */
function folders(list: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of list) {
    for (const dir of parents(path)) out.add(dir);
    if (path.endsWith("/")) out.add(path);
  }
  return out;
}

/**
 * The folders left open in each tree, by `memoryKey`.
 *
 * The tree unmounts when another page is shown, and its model goes with it;
 * coming back opens the folders that were open, not a tree folded shut.
 * Memory only, for the app's lifetime.
 */
const openFolders = new Map<string, string[]>();

export function FilesTree({
  memoryKey,
  base,
  loaded,
  changes,
  onRefresh,
  refreshing,
}: {
  /** The project and folder this tree shows: whose open folders to keep. */
  memoryKey: string;
  base: FileListing;
  loaded: Record<string, FileListing>;
  changes: WorktreeFile[];
  /** Reads the tree again: the same read as the title bar's Refresh. */
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const dark = useDark();
  const [query, setQuery] = useState("");
  /** The row the context menu was opened on. */
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const openFile = useFiles((state) => state.openFile);
  const pin = useFiles((state) => state.pin);
  const loadDir = useFiles((state) => state.loadDir);
  const active = useFiles((state) => state.active);

  const paths = useMemo(() => {
    const seen = new Set(base.paths);
    for (const listing of Object.values(loaded))
      for (const path of listing.paths) seen.add(path);
    return [...seen];
  }, [base, loaded]);

  /** Folders listed but not read yet: the ones to watch for an expand. */
  const unread = useMemo(() => {
    const out = new Set(base.lazy);
    for (const listing of Object.values(loaded))
      for (const dir of listing.lazy) out.add(dir);
    for (const dir of Object.keys(loaded)) out.delete(dir);
    return out;
  }, [base, loaded]);

  const gitStatus = useMemo<GitStatusEntry[]>(() => {
    const status = new Map<string, GitStatus>();
    // Ignored is a property of the folder git named: what is read out of
    // `node_modules/` later is just as ignored, and greys out with it.
    const ignoredDirs = base.ignored.filter((path) => path.endsWith("/"));
    const ignored = (path: string) =>
      ignoredDirs.some((dir) => path.startsWith(dir));
    for (const path of base.ignored) status.set(path, "ignored");
    for (const [dir, listing] of Object.entries(loaded))
      if (ignored(dir))
        for (const path of listing.paths) status.set(path, "ignored");
    const changed = changes.map((file) => ({
      path: file.path,
      status: toGitStatus(file.status),
    }));
    for (const file of changed) status.set(file.path, file.status);
    // A folder takes the strongest change inside it.
    rollUpFolders(status, changed);
    return [...status].map(([path, value]) => ({ path, status: value }));
  }, [base, loaded, changes]);

  // NOTE: Construction-time callbacks, and the model is built once. Refs let
  // a fresh closure still be the one that runs.
  const openRef = useRef(openFile);
  openRef.current = openFile;

  const { model } = useFileTree({
    paths,
    initialExpansion: "closed",
    initialExpandedPaths: openFolders.get(memoryKey),
    // One folder per row, as in the pull request's tree: a folded
    // `src/components/features` truncates every segment at sidebar width.
    flattenEmptyDirectories: false,
    // The filter box above drives `setSearch()`; `true` would draw the
    // library's own field as well (see `pulls/file-tree.tsx`).
    search: false,
    icons: FILE_TREE_ICONS,
    unsafeCSS: TREE_ICON_TINT_CSS + FOLDER_ICON_CSS + FOLDER_STATUS_CSS,
    // An editor's explorer, not a review list: 22px rows.
    density: "compact",
    itemHeight: 22,
    gitStatus,
    onSelectionChange: (selected) => {
      const [path] = selected;
      if (path !== undefined && !path.endsWith("/")) openRef.current(path);
    },
  });

  /**
   * The paths the model holds.
   *
   * Kept so a folder's contents arriving can be added rather than the whole
   * tree rebuilt: a rebuild folds every open folder shut.
   */
  const shown = useRef(new Set(paths));

  useEffect(() => {
    const next = new Set(paths);
    const kept = [...shown.current].every((path) => next.has(path));
    if (kept) {
      const added = paths.filter((path) => !shown.current.has(path));
      if (added.length)
        model.batch(added.map((path) => ({ type: "add" as const, path })));
    } else {
      // Something went away (a refresh after a delete): rebuild, keeping
      // every folder that was open open.
      const still = folders(paths);
      const expanded = [...folders(shown.current)].filter((dir) => {
        if (!still.has(dir)) return false;
        return folder(model.getItem(dir))?.isExpanded() === true;
      });
      model.resetPaths(paths, { initialExpandedPaths: expanded });
    }
    shown.current = next;
  }, [model, paths]);

  // Leaving, the open folders are kept for the next mount. `useFileTree`
  // cleans its model up a tick after unmount, so it still answers here.
  useEffect(
    () => () => {
      const open = [...folders(shown.current)].filter(
        (dir) => folder(model.getItem(dir))?.isExpanded() === true,
      );
      openFolders.set(memoryKey, open);
    },
    [model, memoryKey],
  );

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  useEffect(() => {
    model.setSearch(query.trim() === "" ? null : query);
  }, [model, query]);

  // An unread folder that has just been opened is read.
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  useEffect(
    () =>
      model.subscribe(() => {
        for (const dir of unreadRef.current) {
          if (folder(model.getItem(dir))?.isExpanded()) void loadDir(dir);
        }
      }),
    [model, loadDir],
  );

  // The tab on screen is the row selected. After a tab click, Quick Open or
  // a chat badge, the tree opens down to it, as an editor's explorer follows
  // its editor.
  //
  // A file inside an unread folder (`node_modules/x/y.js`) is reached one
  // folder at a time: expanding the unread one has the watcher above read it,
  // `unread` changes when it lands, and this runs again a level deeper.
  useEffect(() => {
    if (!active || model.getSelectedPaths()[0] === active) return;
    for (const dir of parents(active)) {
      const item = folder(model.getItem(dir));
      if (!item) return;
      if (!item.isExpanded()) item.expand();
      if (unread.has(dir)) return;
    }
    const item = model.getItem(active);
    if (!item) return;
    item.select();
    model.scrollToPath(active, { offset: "nearest" });
  }, [model, active, unread]);

  /**
   * Opens `dir` and every folder below it, or shuts them all when it is open.
   *
   * NOTE: Only folders already read. An unread one (inside `node_modules`)
   * stays shut, or one ⌥-click would read a thousand folders. It still opens
   * a level at a time, the ordinary way.
   */
  const toggleBranch = (dir: string) => {
    const root = folder(model.getItem(dir));
    if (!root) return;
    const opening = !root.isExpanded();
    const below = new Set<string>();
    for (const path of paths) {
      if (!path.startsWith(dir) || path === dir) continue;
      for (const parent of parents(path))
        if (parent.length > dir.length) below.add(parent);
      if (path.endsWith("/")) below.add(path);
    }
    const reachable = (path: string) =>
      ![...unread].some((shut) => path.startsWith(shut) && path !== shut) &&
      !unread.has(path);
    if (opening) {
      root.expand();
      for (const path of below)
        if (reachable(path)) folder(model.getItem(path))?.expand();
    } else {
      for (const path of below) folder(model.getItem(path))?.collapse();
      root.collapse();
    }
  };

  const fileCount = base.paths.filter((path) => !path.endsWith("/")).length;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}…`}
            aria-label="Filter files"
            className="text-xs"
          />
        </InputGroup>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh files"
          title="Refresh"
          disabled={refreshing}
          onClick={onRefresh}
          className="text-muted-foreground shrink-0"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={1.8}
            aria-hidden="true"
            className={refreshing ? "animate-spin" : undefined}
          />
        </Button>
      </div>
      {base.truncated && (
        <p className="text-muted-foreground shrink-0 px-3 pb-1.5 text-xs">
          Only the first {base.paths.length.toLocaleString()} paths are listed.
        </p>
      )}
      {/* The app's own context menu around the tree, not the library's:
          `@pierre/trees` anchors its menu at the row's right edge, and a
          right click should open where the pointer is, as every other menu
          here does. The row comes from the event's composed path, which
          crosses the tree's (open) shadow root. Off a row, no menu. */}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="flex min-h-0 flex-1 flex-col" />}
          // ⌥-click (Alt-click elsewhere) on a folder opens or shuts the
          // whole branch. Capture, so the click is taken before it reaches
          // the tree's shadow root and the library's own toggle never runs.
          onClickCapture={(event) => {
            if (!event.altKey) return;
            const path = rowPath(event.nativeEvent);
            if (!path?.endsWith("/")) return;
            event.preventDefault();
            event.stopPropagation();
            toggleBranch(path);
          }}
          onContextMenuCapture={(event) => {
            const path = rowPath(event.nativeEvent);
            if (!path) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            setMenuPath(path);
          }}
        >
          <FileTree
            model={model}
            className="min-h-0 flex-1"
            style={{ ...treeHostStyle(dark), ...COMPACT_TREE_STYLE }}
            // A double click keeps the preview tab the first click opened
            // (FE-66/D3).
            onDoubleClick={() => {
              const [path] = model.getSelectedPaths();
              if (path !== undefined && !path.endsWith("/")) pin(path);
            }}
          />
        </ContextMenuTrigger>
        {menuPath && <RowMenu path={menuPath} root={base.root} />}
      </ContextMenu>
    </>
  );
}

/**
 * A row's context menu: Finder and the default app, then its paths.
 *
 * A folder's path drops the tree's trailing `/`.
 */
function RowMenu({ path, root }: { path: string; root: string }) {
  const slug = useFiles((state) => state.slug);
  const folder = useFiles((state) => state.folder);
  const relative = path.replace(/\/+$/, "");
  const absolute = `${root.replace(/\/+$/, "")}/${relative}`;
  const surface = window.desktop?.worktree;
  // Failures (the file went away, a refused executable) have no row to show
  // on; the menu has already closed. Logged, never thrown into the tree.
  const run = (action: () => Promise<void>) =>
    void action().catch((error: unknown) => console.warn(error));
  const copy = (text: string) => run(() => navigator.clipboard.writeText(text));

  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!surface || !slug}
        onClick={() =>
          slug && surface && run(() => surface.reveal(slug, relative, folder))
        }
      >
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuItem
        // Opening an app or a script runs it; main refuses those too.
        disabled={!surface || !slug || LAUNCHABLE.test(path)}
        onClick={() =>
          slug &&
          surface &&
          run(() => surface.openDefault(slug, relative, folder))
        }
      >
        Open in Default App
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copy(absolute)}>
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onClick={() => copy(relative)}>
        Copy Relative Path
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
