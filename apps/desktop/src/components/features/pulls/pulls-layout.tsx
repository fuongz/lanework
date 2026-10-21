import { Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useLayout } from "#/stores/layout";
import { usePulls } from "#/stores/pulls";
import { PullsList } from "./pulls-list";

/**
 * The pull-request screen: a list that stays, and one pull request beside it.
 *
 * ⚠️ Refreshed on FOCUS, never on a timer — the same rule `WorkspaceLayout`
 * applies to the board. A desktop window nobody is looking at has nobody to
 * show a change to, and a poll it fires anyway is a request per interval per
 * open window, forever, against an hourly budget.
 */
export function PullsLayout() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues_/pulls" });
  // ⚠️ The state filter is read from the URL and passed INTO the read, not
  // applied to what came back: a merged pull request is not in the open list to
  // be filtered out of.
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

  // ⚠️ Focus mode is left behind when this screen is. It collapses the rail,
  // which lives in the other panel group and has no control of its own — so a
  // mode that outlived the screen that offers the toggle would strand somebody
  // on Issues with no sidebar and nothing to click.
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
          className="bg-sidebar flex h-full min-h-0 flex-col"
        >
          <PullsList />
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="Resize pull request list" />

      {/* ⚠️ ONE panel for the whole pull request, and the file tree is no longer
          a sibling of it. The tree used to be a full-height column of the window
          — which put it alongside the pull request's TITLE, a row that says
          nothing about files. It is now a panel inside the detail pane, below
          that title row, so the header spans the width it describes and the
          tree begins where the diff does. See `PullDetail`. */}
      <ResizablePanel id="detail" minSize="40%">
        <Outlet />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
