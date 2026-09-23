import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useLayout } from "#/stores/layout";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";

/**
 * The window: a rail beside one scrolling pane.
 *
 * ⚠️ Only the pane scrolls. A shell that scrolls as a whole takes the project
 * switcher and the lane list off screen the moment a board is long, which is
 * the one thing a persistent sidebar exists to prevent.
 *
 * ⚠️ The rail is a PANEL now, not a fixed `w-60`, so it is draggable on every
 * route rather than only on the one that asked for it. A sidebar that resizes
 * under Pull requests and is frozen under Issues reads as a bug, not a feature.
 */
export function AppShell() {
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:shell",
    ["sidebar", "main"],
  );
  const focusMode = useLayout((state) => state.focusMode);
  const sidebarRef = usePanelRef();

  // ⚠️ Driven FROM the store, never the other way round. The rail has no
  // collapse control of its own — focus mode is asked for from a pull request's
  // header, in the other panel group — so this is a one-way effect rather than
  // the two-way binding the files panel needs.
  useEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (focusMode) panel.collapse();
    else panel.expand();
  }, [focusMode, sidebarRef]);

  return (
    <div className="h-screen overflow-hidden">
      <ResizablePanelGroup
        id="lanework:shell"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {/* ⚠️ Sized in pixels, and `preserve-pixel-size`. A rail is a column of
            labels, not a proportion of the window: held as a percentage it
            grows into empty space every time somebody maximises the window. */}
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarRef}
          defaultSize="240px"
          minSize="180px"
          maxSize="380px"
          collapsible
          collapsedSize="0px"
          groupResizeBehavior="preserve-pixel-size"
        >
          <AppSidebar />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize sidebar" />
        <ResizablePanel id="main" minSize="40%">
          <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CommandPalette />
    </div>
  );
}
