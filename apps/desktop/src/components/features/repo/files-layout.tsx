import { RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";
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
import { useFiles } from "#/stores/files";
import { useWorktree } from "#/stores/worktree";
import { FileTabs, FileView } from "./file-view";
import { FilesTree } from "./files-tree";
import { QuickOpen } from "./quick-open";

/**
 * Repository › Files (FE-66): the working tree on the left, the files open
 * from it on the right — an editor's explorer, read-only (FE-66/D1).
 *
 * ⚠️ The worktree STATUS is read too, the way Changes reads it: it says
 * whether there is a repository at all (`RepoEmpty` otherwise), and it is
 * what colours the tree's changed rows (FE-66/D7).
 *
 * ⚠️ Read on entry and on window focus, never on a timer (FE-22/D10).
 */
export function FilesLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/files" });
  const openWorktree = useWorktree((state) => state.open);
  const refreshWorktree = useWorktree((state) => state.refresh);
  const state = useWorktree((state) => state.state);
  const worktreeError = useWorktree((state) => state.error);
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

  const ready = state?.kind === "ready";

  useEffect(() => {
    void openWorktree(slug);
  }, [openWorktree, slug]);

  useEffect(() => {
    if (ready) void open(slug);
  }, [open, slug, ready]);

  useEffect(() => {
    const onFocus = () => {
      void refreshWorktree();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, refreshWorktree]);

  // ⌘P finds a file; ⌘W closes the open one (FE-66/D3, D8). The menu leaves
  // ⌘W unbound on purpose (`menu.ts`), so it reaches the page.
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

  // ⚠️ Drawn in every state (FE-58), so the screen keeps its name while the
  // repository is read, and when it is not one.
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
        onClick={() => {
          void refreshWorktree();
          void refresh();
        }}
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

  if (!state)
    return (
      <>
        {title}
        {worktreeError ? (
          <RepoMessage
            title="The repository could not be read"
            description={worktreeError}
          />
        ) : (
          <p className="text-muted-foreground p-4 text-xs">
            Reading the repository…
          </p>
        )}
      </>
    );
  if (state.kind !== "ready")
    return (
      <>
        {title}
        <RepoEmpty state={state} />
      </>
    );
  if (!base)
    return (
      <>
        {title}
        {error ? (
          <RepoMessage
            title="The folder could not be read"
            description={error}
          />
        ) : (
          <p className="text-muted-foreground p-4 text-xs">
            Reading the files…
          </p>
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
            {/* ⚠️ Keyed by project: the model's expansion and selection are
                about one repository's paths, never another's. */}
            <FilesTree
              key={slug}
              base={base}
              loaded={loaded}
              changes={state.files}
            />
          </aside>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize file tree" />
        <ResizablePanel id="file" minSize="40%">
          <div className="flex h-full min-h-0 flex-col">
            <FileTabs changes={state.files} />
            <FileView slug={slug} changes={state.files} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <QuickOpen paths={base.paths} />
    </>
  );
}
