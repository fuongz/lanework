import { Outlet, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useBoard } from "#/stores/board";
import { usePresencePoll } from "#/stores/board-presence";
import { useGitHubIssues } from "#/stores/github-issues";
import { useLayout } from "#/stores/layout";
import { useCloudFeatures } from "#/stores/session";
import { IssuesList } from "./issues-list";

/**
 * The issues screen: a list that stays, and one issue beside it (FE-75).
 *
 * The same shape as `PullsLayout`. The list lives here, not in a child route,
 * so moving between issues never remounts it and it keeps its scroll.
 *
 * NOTE: GitHub issues are re-read on FOCUS, never on a timer (FE-75/D7). A
 * window nobody is looking at has nobody to show a change to, and a poll
 * would spend the user's `gh` budget per interval per open window.
 */
export function IssuesLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues" });
  const workspace = useBoard(
    (state) => state.workspaces.find((entry) => entry.slug === slug) ?? null,
  );
  // Nobody else is on a local board, so there is nothing to poll (FE-52/D10).
  const { presence } = useCloudFeatures(workspace);
  usePresencePoll(presence ? (workspace?.id ?? null) : null);

  const openGitHub = useGitHubIssues((state) => state.open);
  const refreshGitHub = useGitHubIssues((state) => state.refresh);
  const focusMode = useLayout((state) => state.focusMode);
  const exitFocusMode = useLayout((state) => state.exitFocusMode);
  const listRef = usePanelRef();

  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:issues",
    ["list", "detail"],
  );

  useEffect(() => {
    void openGitHub(slug);
  }, [openGitHub, slug]);

  useEffect(() => {
    const onFocus = () => void refreshGitHub(slug);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGitHub, slug]);

  // NOTE: Focus mode is left behind when this screen is. It collapses the
  // rail, which has no control of its own; a mode that outlived the screen
  // that offers the toggle would strand somebody with no sidebar.
  useEffect(() => exitFocusMode, [exitFocusMode]);

  useEffect(() => {
    const panel = listRef.current;
    if (!panel) return;
    if (focusMode) panel.collapse();
    else panel.expand();
  }, [focusMode, listRef]);

  return (
    <ResizablePanelGroup
      id="lanework:issues"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="list"
        panelRef={listRef}
        defaultSize="340px"
        minSize="18%"
        maxSize="45%"
        collapsible
        collapsedSize="0px"
        groupResizeBehavior="preserve-pixel-size"
      >
        {/* The list column's ground is the Pull requests list's, so the
            two tabs read as one column (FE-75). */}
        <aside
          aria-label="Issues"
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          <IssuesList />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize issue list" />
      <ResizablePanel id="detail" minSize="40%">
        <Outlet />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
