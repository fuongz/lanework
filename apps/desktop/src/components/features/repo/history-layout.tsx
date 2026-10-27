import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Outlet, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { SplitSkeleton } from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { RepoEmpty, RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { useWorktree } from "#/stores/worktree";
import { HistoryList } from "./history-list";

/**
 * Repository › History: the commit list, and one commit beside it.
 *
 * The chosen commit is in the URL (`history/$sha`), like a pull request's
 * number: Back returns to the previous commit, and a link carries it.
 */
export function HistoryLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/history" });
  const open = useWorktree((state) => state.open);
  const openHistory = useWorktree((state) => state.openHistory);
  const state = useWorktree((state) => state.state);
  const error = useWorktree((state) => state.error);
  const refresh = useWorktree((state) => state.refresh);
  const loading = useWorktree((state) => state.historyLoading);

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:history",
    ["list", "detail"],
  );

  // NOTE: Status first, for the one thing History needs from it: whether
  // there is a repository at all. Without it a folder that is not one would
  // read as a repository with no commits.
  useEffect(() => {
    void open(slug).then(() => openHistory(slug));
  }, [open, openHistory, slug]);

  // The screen's name in the window's title bar, drawn by the layout rather
  // than the list, so it is there while the repository is read and when there
  // is none. A commit's own header stays in its pane: the bar holds one
  // header, and the commit's is the diff's first row.
  const title = (
    <WindowTitlebar>
      <h1 className={WINDOW_TITLE}>History</h1>
      <span className="ml-auto" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh history"
        title="Refresh"
        disabled={loading}
        onClick={() => void refresh().then(() => openHistory(slug))}
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
        {error ? (
          <RepoMessage
            title="The repository could not be read"
            description={error}
          />
        ) : (
          <SplitSkeleton label="Reading the repository" lines={2} />
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

  return (
    <ResizablePanelGroup
      id="lanework:history"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize="280px"
        minSize="15%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside
          aria-label="History"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          {title}
          <HistoryList />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize commit list" />
      <ResizablePanel id="detail" minSize="40%">
        <div className="flex h-full min-h-0">
          <Outlet />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
