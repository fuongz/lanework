import { Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { useLayout } from "#/stores/layout";
import { usePulls } from "#/stores/pulls";
import { PullsList } from "./pulls-list";

/**
 * The pull request screen: a list that stays, and one pull request beside it.
 *
 * Refreshed on focus, never on a timer, as `WorkspaceLayout` does for the
 * board. A window nobody is looking at has nobody to show a change to, and a
 * poll costs a request per interval per window against an hourly budget.
 */
export function PullsLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues_/pulls" });
  // The state filter goes from the URL into the read, not over what came
  // back: a merged pull request is not in the open list to be filtered out of.
  const { status } = useSearch({ from: "/_app/w/$slug/issues_/pulls" });
  const open = usePulls((state) => state.open);
  const refresh = usePulls((state) => state.refresh);
  const watch = usePulls((state) => state.watch);
  const focusMode = useLayout((state) => state.focusMode);
  const exitFocusMode = useLayout((state) => state.exitFocusMode);
  const listRef = usePanelRef();

  // NOTE: The issue list's layout, not one of its own. Issues and Pull
  // requests are two tabs over one list column (FE-75), so the column keeps
  // its width when the tab changes.
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:issues",
    ["list", "detail"],
  );

  useEffect(() => {
    void open(slug, status);
  }, [open, slug, status]);

  useEffect(() => watch(), [watch]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // NOTE: Focus mode ends when this screen does. It collapses the rail, which
  // has no control of its own, so a mode that outlived the screen offering the
  // toggle would strand someone on Issues with no sidebar and nothing to
  // click.
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
        <aside
          aria-label="Pull requests"
          className="flex h-full min-h-0 flex-col"
        >
          <PullsList />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize pull request list" />

      {/* One panel for the whole pull request. The file tree is a panel
          inside it, below the title row, so the header spans the width it
          describes and the tree begins where the diff does (see
          `PullDetail`). */}
      <ResizablePanel id="detail" minSize="40%">
        <Outlet />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
