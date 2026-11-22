import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { SplitSkeleton } from "#/components/shared/loading/skeletons";
import {
  HeldReadAction,
  RepoEmpty,
  RepoMessage,
} from "#/components/shared/repo/repo-empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { savedFolder, saveFolder, useFiles } from "#/stores/files";
import { useWorktree } from "#/stores/worktree";
import type { PickedFolder } from "../../../../shared/projects";
import { FileTabs, FileView } from "./file-view";
import { FilesSearch } from "./files-search";
import { FilesTree } from "./files-tree";
import { FolderSwitcher } from "./folder-switcher";
import { QuickOpen } from "./quick-open";

/**
 * Repository › Files: the working tree on the left, the files open from it on
 * the right.
 *
 * An editor's explorer; a text file opens editable, ⌘S saves it and ⌘⌥S
 * saves every open file.
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
  const askAgain = useWorktree((state) => state.askAgain);
  const initRepo = useWorktree((state) => state.initRepo);
  const initializing = useWorktree((state) => state.initializing);
  const initError = useWorktree((state) => state.initError);
  const folderStatus = useFiles((state) => state.folderStatus);
  const open = useFiles((state) => state.open);
  const refresh = useFiles((state) => state.refresh);
  const base = useFiles((state) => state.base);
  const loaded = useFiles((state) => state.loaded);
  const error = useFiles((state) => state.error);
  const loading = useFiles((state) => state.loading);
  const active = useFiles((state) => state.active);
  const requestClose = useFiles((state) => state.requestClose);
  const save = useFiles((state) => state.save);
  const saveAll = useFiles((state) => state.saveAll);
  const confirmDiscard = useFiles((state) => state.confirmDiscard);
  const setQuickOpen = useFiles((state) => state.setQuickOpen);
  // ⌘⇧F puts the search in the tree's place (FE-149); each press moves
  // `searchFocus` so a second one takes the box again.
  const [searching, setSearching] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);

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
    const api = window.desktop?.projects.folder;
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

  // Another folder shows other buffers: unsaved edits are asked about first.
  const pick = (index: number) => {
    const path = index > 0 ? (folders?.[index]?.path ?? null) : null;
    confirmDiscard({
      reason: "switch",
      proceed: () => {
        setChosen(path);
        saveFolder(slug, path);
      },
    });
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

  // ⌘P finds a file; ⌘W closes the open one (FE-66/D3, D8); ⌘⇧F searches
  // the files' text (FE-149); ⌘S saves the open file and ⌘⌥S every one. The
  // menu leaves ⌘W and ⌘S unbound (`menu.ts`) so they reach the page, and
  // Pierre's editor keymap has neither.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      // By `code`: with ⌥ held, macOS reports `key` as "ß".
      if (event.code === "KeyS" && !event.shiftKey) {
        event.preventDefault();
        if (event.altKey) void saveAll();
        else if (active) void save(active);
        return;
      }
      if (event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (key !== "f") return;
        event.preventDefault();
        setSearching(true);
        setSearchFocus((was) => was + 1);
        return;
      }
      if (key === "p") {
        event.preventDefault();
        setQuickOpen(true);
      } else if (key === "w" && active) {
        event.preventDefault();
        requestClose([active]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, requestClose, save, saveAll, setQuickOpen]);

  const refreshAll = () => {
    void refreshWorktree();
    void refresh();
    void readFolders();
  };

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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {lone}
          {readError ? (
            <RepoMessage
              title="The repository could not be read"
              description={readError}
            >
              <HeldReadAction
                message={readError}
                onRetry={async (refusal) => {
                  if (refusal === "refused") await askAgain(slug, folder);
                  refreshAll();
                }}
              />
            </RepoMessage>
          ) : (
            <SplitSkeleton label="Reading the repository" />
          )}
        </div>
      </div>
    );
  if (state.kind !== "ready")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {lone}
          <RepoEmpty
            state={state}
            init={{
              busy: initializing !== null,
              error: initError?.folder === folder ? initError.message : null,
              onInit: () => {
                void initRepo(slug, folder).then((made) => {
                  // The primary's tree opens by itself once its status is
                  // ready (the effect above); another folder is read here.
                  if (made && folder > 0) void refresh();
                });
              },
            }}
          />
        </div>
      </div>
    );
  if (!base)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {lone}
          {error ? (
            <RepoMessage
              title="The folder could not be read"
              description={error}
            />
          ) : (
            <SplitSkeleton label="Reading the files" />
          )}
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
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
              className="bg-background flex h-full min-h-0 flex-col"
            >
              {switcher}
              {/* NOTE: Keyed by project and folder. The model's expansion and
                selection are about one repository's paths, never another's;
                a search is about one folder's files. */}
              {searching ? (
                <FilesSearch
                  key={`${slug}#${folder}`}
                  slug={slug}
                  folder={folder}
                  focusRequest={searchFocus}
                  onClose={() => setSearching(false)}
                />
              ) : (
                <FilesTree
                  key={`${slug}#${folder}`}
                  memoryKey={`${slug}#${folder}`}
                  base={base}
                  loaded={loaded}
                  changes={state.files}
                  onRefresh={refreshAll}
                  refreshing={loading}
                />
              )}
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
      </div>
    </div>
  );
}
