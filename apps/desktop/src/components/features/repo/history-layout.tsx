import { Outlet, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { RepoEmpty, RepoMessage } from "#/components/shared/repo/repo-empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useWorktree } from "#/stores/worktree";
import { HistoryList } from "./history-list";

/**
 * Repository › History: the commit list, and one commit beside it (FE-22).
 *
 * ⚠️ The chosen commit is in the URL (`history/$sha`), like a pull request's
 * number: Back returns to the previous commit, and a link carries it.
 */
export function HistoryLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/history" });
  const open = useWorktree((state) => state.open);
  const openHistory = useWorktree((state) => state.openHistory);
  const state = useWorktree((state) => state.state);
  const error = useWorktree((state) => state.error);

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:history",
    ["list", "detail"],
  );

  // ⚠️ Status first, for the ONE thing History needs from it: whether there is
  // a repository at all. Without it a folder that is not one would read as a
  // repository with no commits.
  useEffect(() => {
    void open(slug).then(() => openHistory(slug));
  }, [open, openHistory, slug]);

  if (!state)
    return error ? (
      <RepoMessage
        title="The repository could not be read"
        description={error}
      />
    ) : (
      <p className="text-muted-foreground p-4 text-xs">
        Reading the repository…
      </p>
    );
  if (state.kind !== "ready") return <RepoEmpty state={state} />;

  return (
    <ResizablePanelGroup
      id="lanework:history"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        defaultSize="340px"
        minSize="18%"
        maxSize="45%"
        groupResizeBehavior="preserve-pixel-size"
      >
        <aside
          aria-label="History"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
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
