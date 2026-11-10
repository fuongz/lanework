// The working tree, as a tree.
//
// - Lazy below what git ignores. The first read is git's list plus the
//   ignored folders as empty rows; opening `node_modules/` reads that one
//   folder, and each folder inside it waits for its own click.
//   `@pierre/trees` has no "load children" hook, so the tree is watched
//   (`subscribe`) for an unread folder that has just been expanded.
// - A web component with its own shadow root, styled through variables on
//   the host: see `treeHostStyle`.
// - New Folder and drag and drop are the only writes. Both go through main
//   (`worktree.mkdir`, `worktree.move`); the model shows the result before
//   main answers and is put back when main refuses.
import {
  Cancel01Icon,
  FolderAddIcon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeDropTarget,
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
import { ipcMessage } from "#/lib/ipc-error";
import { type MovedPath, movedPath, parentDir, useFiles } from "#/stores/files";
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

/** The last part of a tree path, a folder's keeping its `/`: `c/` for `a/b/c/`. */
function baseName(path: string): string {
  return path.slice(parentDir(path).length);
}

/** Whether a path is `.git` or inside one: never moved, never a target. */
function inGit(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === ".git");
}

/** The folder a drop lands in: `''` for the top, `null` for nowhere. */
function dropDir(target: FileTreeDropTarget): string | null {
  return target.kind === "root" ? "" : target.directoryPath;
}

/**
 * What the model did on a drop, as `worktree.move` reports it.
 *
 * Entries already in the target stay where they are; main skips those too.
 */
function plannedMoves(event: FileTreeDropContext): MovedPath[] {
  const dir = dropDir(event.target) ?? "";
  return event.draggedPaths
    .filter((from) => parentDir(from) !== dir)
    .map((from) => ({ from, to: `${dir}${baseName(from)}` }));
}

/** Whether two move lists say the same thing, in any order. */
function sameMoves(a: readonly MovedPath[], b: readonly MovedPath[]): boolean {
  const key = ({ from, to }: MovedPath) => `${from}\0${to}`;
  const left = new Set(a.map(key));
  return a.length === b.length && b.every((move) => left.has(key(move)));
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
  const slug = useFiles((state) => state.slug);
  const folderIndex = useFiles((state) => state.folder);
  const madeDirs = useFiles((state) => state.madeDirs);
  const addDir = useFiles((state) => state.addDir);
  const applyMove = useFiles((state) => state.applyMove);
  /** The last write main refused, shown above the tree until dismissed. */
  const [failure, setFailure] = useState<string | null>(null);

  const paths = useMemo(() => {
    const seen = new Set(base.paths);
    for (const listing of Object.values(loaded))
      for (const path of listing.paths) seen.add(path);
    for (const dir of madeDirs) seen.add(dir);
    return [...seen];
  }, [base, loaded, madeDirs]);

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
  const dropRef = useRef<(event: FileTreeDropResult) => void>(() => {});
  const renameRef = useRef<(from: string, to: string) => void>(() => {});
  const renameErrorRef = useRef<(error: string) => void>(() => {});
  /** Whether a drop may land: a folder or the top, read, outside `.git`. */
  const canDropRef = useRef<(event: FileTreeDropContext) => boolean>(
    () => false,
  );
  /**
   * The New Folder row being named: a placeholder, its name blank, that the
   * library's own rename field edits. `committing` once Enter has sent the
   * name to main.
   */
  const creating = useRef<{ placeholder: string; committing: boolean } | null>(
    null,
  );

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
      // Only a file on disk opens: mid-drop, the selection is already on a
      // path main has not moved anything to yet.
      if (path !== undefined && !path.endsWith("/") && shown.current.has(path))
        openRef.current(path);
    },
    // Renaming is New Folder's naming field, and nothing else: F2 on a row
    // is refused (`canRename`).
    renaming: {
      canRename: (item) =>
        creating.current !== null &&
        !creating.current.committing &&
        `${item.path}/` === creating.current.placeholder,
      onRename: (event) =>
        renameRef.current(event.sourcePath, event.destinationPath),
      onError: (error) => renameErrorRef.current(error),
    },
    dragAndDrop: {
      canDrag: (dragged) =>
        creating.current === null && !dragged.some((path) => inGit(path)),
      canDrop: (event) => canDropRef.current(event),
      onDropComplete: (event) => dropRef.current(event),
      // The model refused the move before main was asked: a name already
      // in the target folder.
      onDropError: (error) => setFailure(error),
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
      // A path the model already holds (a folder made here, or one a drop
      // emptied) is not added twice.
      const added = paths.filter(
        (path) => !shown.current.has(path) && model.getItem(path) === null,
      );
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
      // A rebuild drops a New Folder row still being named.
      if (creating.current && !creating.current.committing)
        creating.current = null;
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
        // Escape, or Enter on a blank name: the library has removed the
        // New Folder row by itself.
        const made = creating.current;
        if (
          made &&
          !made.committing &&
          model.getItem(made.placeholder) === null
        )
          creating.current = null;
      }),
    [model, loadDir],
  );

  const surface = window.desktop?.worktree;
  const report = (error: unknown, fallback: string) => {
    console.warn(error);
    setFailure(ipcMessage(error, fallback));
  };

  /** The folders open in the model, of those `dirs` names after `moves`. */
  const openAfter = (dirs: Iterable<string>, moves: readonly MovedPath[]) =>
    [...dirs].filter(
      (dir) =>
        folder(model.getItem(movedPath(dir, moves)))?.isExpanded() === true,
    );

  /**
   * New Folder inside `parent` (`''` for the top), named in the tree.
   *
   * A placeholder row with a blank name is added and handed to the
   * library's rename field: Enter sends the name (`renameRef`), Escape or a
   * blank name drops the row.
   */
  const newFolder = (parent: string) => {
    if (creating.current || !slug || !surface) return;
    setFailure(null);
    // Renaming clears the model's filter; the box above clears with it.
    setQuery("");
    if (parent) folder(model.getItem(parent))?.expand();
    let leaf = " ";
    while (model.getItem(`${parent}${leaf}/`)) leaf += " ";
    const placeholder = `${parent}${leaf}/`;
    creating.current = { placeholder, committing: false };
    model.add(placeholder);
    if (!model.startRenaming(placeholder, { removeIfCanceled: true })) {
      creating.current = null;
      model.remove(placeholder, { recursive: true });
      return;
    }
    model.scrollToPath(placeholder, { offset: "nearest" });
  };

  renameRef.current = (from, to) => {
    const made = creating.current;
    if (!made || `${from}/` !== made.placeholder || !slug || !surface) return;
    made.committing = true;
    const dir = `${to}/`;
    // The library moves the row to `dir` right after this returns.
    void surface
      .mkdir(slug, to, folderIndex)
      .then(() => {
        shown.current.add(dir);
        addDir(dir);
        const parent = parentDir(dir);
        if (parent) folder(model.getItem(parent))?.expand();
        model.getItem(dir)?.select();
        model.focusPath(dir);
        model.scrollToPath(dir, { offset: "nearest" });
      })
      .catch((error: unknown) => {
        if (model.getItem(dir)) model.remove(dir, { recursive: true });
        report(error, "The folder could not be made.");
      })
      .finally(() => {
        if (creating.current === made) creating.current = null;
      });
  };

  // The name is taken in the model already: the row goes, and why is shown.
  renameErrorRef.current = (error) => {
    const made = creating.current;
    if (!made) return;
    creating.current = null;
    if (model.getItem(made.placeholder))
      model.remove(made.placeholder, { recursive: true });
    setFailure(error);
  };

  canDropRef.current = ({ draggedPaths, target }) => {
    const dir = dropDir(target);
    if (dir === null || creating.current) return false;
    if (dir && (inGit(dir) || unread.has(dir))) return false;
    // Never a folder into itself or a folder inside it.
    if (draggedPaths.some((path) => path.endsWith("/") && dir.startsWith(path)))
      return false;
    // Somewhere else, at least one of them.
    return draggedPaths.some((path) => parentDir(path) !== dir);
  };

  dropRef.current = (event) => {
    const planned = plannedMoves(event);
    const toDir = dropDir(event.target) ?? "";
    const before = shown.current;
    if (!slug || !surface || planned.length === 0) {
      model.resetPaths([...before], {
        initialExpandedPaths: openAfter(folders(before), planned),
      });
      return;
    }
    setFailure(null);
    void surface
      .move(slug, [...event.draggedPaths], toDir, folderIndex)
      .then(({ moved }) => {
        const next = new Set([...before].map((path) => movedPath(path, moved)));
        if (!sameMoves(moved, planned)) {
          // Main moved something else than the model did: the model is
          // rebuilt from what main says.
          const open = openAfter(folders(before), planned).map((dir) =>
            movedPath(dir, moved),
          );
          model.resetPaths([...next], { initialExpandedPaths: open });
        }
        shown.current = next;
        applyMove(moved);
        onRefresh();
      })
      .catch((error: unknown) => {
        // Back as it was, open folders kept, then read again: a move that
        // failed half way has still moved what came before.
        model.resetPaths([...before], {
          initialExpandedPaths: openAfter(folders(before), planned),
        });
        report(error, "The files could not be moved.");
        onRefresh();
      });
  };

  /** Where New Folder lands for a row: in a folder, or beside a file. */
  const pendingFolder = useRef<string | null>(null);

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
          aria-label="New folder"
          title="New folder"
          disabled={!slug || !surface}
          onClick={() => newFolder("")}
          className="text-muted-foreground shrink-0"
        >
          <HugeiconsIcon
            icon={FolderAddIcon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
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
      {failure && (
        <div
          role="alert"
          className="text-destructive flex shrink-0 items-start gap-1 px-3 pb-1.5 text-xs"
        >
          <p className="min-w-0 flex-1 pt-0.5 break-words">{failure}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setFailure(null)}
            className="text-muted-foreground shrink-0"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </Button>
        </div>
      )}
      {/* The app's own context menu around the tree, not the library's:
          `@pierre/trees` anchors its menu at the row's right edge, and a
          right click should open where the pointer is, as every other menu
          here does. The row comes from the event's composed path, which
          crosses the tree's (open) shadow root. Off a row, no menu. */}
      <ContextMenu
        // New Folder starts once the menu has gone: the menu hands focus
        // back as it closes, which would blur (and so commit) the field.
        onOpenChangeComplete={(open) => {
          const parent = pendingFolder.current;
          if (open || parent === null) return;
          pendingFolder.current = null;
          newFolder(parent);
        }}
      >
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
        {menuPath && (
          <RowMenu
            path={menuPath}
            root={base.root}
            onNewFolder={() => {
              pendingFolder.current = menuPath.endsWith("/")
                ? menuPath
                : parentDir(menuPath);
            }}
            newFolderTaken={() => pendingFolder.current !== null}
          />
        )}
      </ContextMenu>
    </>
  );
}

/**
 * A row's context menu: Finder and the default app, then its paths.
 *
 * A folder's path drops the tree's trailing `/`.
 */
function RowMenu({
  path,
  root,
  onNewFolder,
  newFolderTaken,
}: {
  path: string;
  root: string;
  /** New Folder in this folder, or beside this file. */
  onNewFolder: () => void;
  /** Whether New Folder was picked: focus then stays off the tree's row. */
  newFolderTaken: () => boolean;
}) {
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
    <ContextMenuContent finalFocus={() => !newFolderTaken()}>
      <ContextMenuItem disabled={!surface || !slug} onClick={onNewFolder}>
        New Folder…
      </ContextMenuItem>
      <ContextMenuSeparator />
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
