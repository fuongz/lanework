import { RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { SplitSkeleton } from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { RepoEmpty, RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import { Kbd } from "#/components/ui/kbd";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { savedFolder, saveFolder, useFiles } from "#/stores/files";
import { useWorktree } from "#/stores/worktree";
import type { PickedFolder } from "../../../../shared/workspaces";
import { FileTabs, FileView } from "./file-view";
import { FilesTree } from "./files-tree";
import { FolderSwitcher } from "./folder-switcher";
import { QuickOpen } from "./quick-open";

/**
 * Repository › Files: the working tree on the left, the files open from it on
 * the right.
 *
 * An editor's explorer, read-only (FE-66/D1).
 *
 * - The worktree status is read too, the way Changes reads it. It says
 *   whether there is a repository at all ({@link RepoEmpty} otherwise), and
 *   it colours the tree's changed rows (FE-66/D7).
 * - Read on entry and on window focus, never on a timer (FE-22/D10).
 */
export function FilesLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/files" });
  const openWorktree = useWorktree((state) => state.open);
  const refreshWorktree = useWorktree((state) => state.refresh);
  const primaryState = useWorktree((state) => state.state);
  const worktreeError = useWorktree((state) => state.error);
  const folderStatus = useFiles((state) => state.folderStatus);
  const open = useFiles((state) => state.open);
  const refresh = useFiles((state) => state.refresh);
  const base = useFiles((state) => state.base);
  const loaded = useFiles((state) => state.loaded);
  const error = useFiles((state) => state.error);
  const loading = useFiles((state) => state.loading);
  const active = useFiles((state) => state.active);
  const close = useFiles((state) => state.close);
  const setQuickOpen = useFiles((state) => state.setQuickOpen);

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:files",
    ["tree", "file"],
  );

  // The project's linked folders, primary first. Null until read: the
  // remembered folder is only known once the list is, and opening the primary
  // first would flash its tree before switching.
  const [folders, setFolders] = useState<PickedFolder[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => savedFolder(slug));
  const readFolders = useCallback(async () => {
    const api = window.desktop?.workspaces.folder;
    const list = api ? await api.list(slug).catch(() => []) : [];
    setFolders(list);
  }, [slug]);

  useEffect(() => {
    setFolders(null);
    setChosen(savedFolder(slug));
    void readFolders();
  }, [slug, readFolders]);

  // A remembered folder that is no longer linked falls back to the primary,
  // and is forgotten (FE-71/D4).
  const found =
    folders && chosen ? folders.findIndex((f) => f.path === chosen) : -1;
  const folder = found > 0 ? found : 0;
  useEffect(() => {
    if (folders && chosen && found <= 0) saveFolder(slug, null);
  }, [folders, chosen, found, slug]);

  const pick = (index: number) => {
    const path = index > 0 ? (folders?.[index]?.path ?? null) : null;
    setChosen(path);
    saveFolder(slug, path);
  };

  // The primary's status is the worktree store's, which Changes and the rail
  // read too; another folder's is read by the Files store (FE-71/D1).
  const state = folder > 0 ? folderStatus : primaryState;
  const primaryReady = primaryState?.kind === "ready";

  useEffect(() => {
    void openWorktree(slug);
  }, [openWorktree, slug]);

  useEffect(() => {
    if (folders === null) return;
    if (folder > 0 || primaryReady) void open(slug, folder);
  }, [open, slug, folder, folders, primaryReady]);

  useEffect(() => {
    const onFocus = () => {
      void refreshWorktree();
      void refresh();
      void readFolders();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, refreshWorktree, readFolders]);

  // ⌘P finds a file; ⌘W closes the open one (FE-66/D3, D8). The menu leaves
  // ⌘W unbound (`menu.ts`) so it reaches the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
        return;
      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        setQuickOpen(true);
      } else if (key === "w" && active) {
        event.preventDefault();
        close(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close, setQuickOpen]);

  const refreshAll = () => {
    void refreshWorktree();
    void refresh();
    void readFolders();
  };

  // Drawn in every state, so the screen keeps its name while the repository
  // is read, and when the folder is not one.
  const title = (
    <WindowTitlebar>
      <h1 className={WINDOW_TITLE}>Files</h1>
      <span className="ml-auto" />
      <Button
        variant="ghost"
        size="sm"
        disabled={!base}
        onClick={() => setQuickOpen(true)}
      >
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        Go to File
        <Kbd>⌘P</Kbd>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh files"
        title="Refresh"
        disabled={loading}
        onClick={refreshAll}
      >
        <HugeiconsIcon
          icon={RefreshIcon}
          strokeWidth={1.8}
          aria-hidden="true"
          className={loading ? "animate-spin" : undefined}
        />
      </Button>
    </WindowTitlebar>
  );

  const switcher =
    folders && folders.length > 1 ? (
      <FolderSwitcher folders={folders} index={folder} onChange={pick} />
    ) : null;
  // Drawn above every state that is not the tree, too: a picked folder that
  // is not a repository must still offer the way back to another.
  const lone = switcher && <div className="w-72 shrink-0">{switcher}</div>;
  const readError = folder > 0 ? error : worktreeError;

  if (!state)
    return (
      <>
        {title}
        {lone}
        {readError ? (
          <RepoMessage
            title="The repository could not be read"
            description={readError}
          />
        ) : (
          <SplitSkeleton label="Reading the repository" />
        )}
      </>
    );
  if (state.kind !== "ready")
    return (
      <>
        {title}
        {lone}
        <RepoEmpty state={state} />
      </>
    );
  if (!base)
    return (
      <>
        {title}
        {lone}
        {error ? (
          <RepoMessage
            title="The folder could not be read"
            description={error}
          />
        ) : (
          <SplitSkeleton label="Reading the files" />
        )}
      </>
    );

  return (
    <>
      {title}
      <ResizablePanelGroup
        id="lanework:files"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="tree"
          defaultSize="280px"
          minSize="15%"
          maxSize="45%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside
            aria-label="Files"
            className="bg-sidebar flex h-full min-h-0 flex-col"
          >
            {switcher}
            {/* NOTE: Keyed by project and folder. The model's expansion and
                selection are about one repository's paths, never another's. */}
            <FilesTree
              key={`${slug}#${folder}`}
              base={base}
              loaded={loaded}
              changes={state.files}
              onRefresh={refreshAll}
              refreshing={loading}
            />
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize file tree" />
        <ResizablePanel id="file" minSize="40%">
          <div className="flex h-full min-h-0 flex-col">
            <FileTabs changes={state.files} />
            <FileView
              slug={slug}
              changes={state.files}
              changesLink={folder === 0}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <QuickOpen paths={base.paths} />
    </>
  );
}
