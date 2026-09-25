import { Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePanelRef } from "react-resizable-panels";
import { TerminalMinibar } from "#/components/features/terminal/terminal-minibar";
import { TerminalPanel } from "#/components/features/terminal/terminal-panel";
import { useTerminalSessions } from "#/components/features/terminal/use-terminal-sessions";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
} from "#/components/ui/resizable";
import { useBoard } from "#/stores/board";
import { useLayout } from "#/stores/layout";
import { terminalShown, useTerminal } from "#/stores/terminal";
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
  const terminalRef = usePanelRef();
  // ⚠️ The project in the URL, not the board store's `active`: on the project
  // picker there is no project, so no terminal — neither the panel nor its
  // bar — rather than whichever project's was open last.
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const workspaceKey = useBoard((state) => {
    const found = slug
      ? state.workspaces.find((entry) => entry.slug === slug)
      : undefined;
    return found ? (found.id ?? found.slug) : null;
  });
  const keyRef = useRef(workspaceKey);
  keyRef.current = workspaceKey;
  const terminalShowing = useTerminal((state) =>
    terminalShown(state, workspaceKey),
  );
  const setTerminalHeight = useTerminal((state) => state.setHeight);
  const setTerminalOpen = useTerminal((state) => state.setOpen);
  useTerminalSessions(workspaceKey);

  // View › Toggle Terminal (⌘`, and ⌃`) and New Terminal (⌘T, and ⌃⇧`), from
  // the app menu.
  useEffect(
    () =>
      window.desktop?.terminal.onCommand((command) => {
        const terminal = useTerminal.getState();
        if (command === "toggle") void terminal.toggle(keyRef.current);
        else void terminal.newTerminal(keyRef.current);
      }),
    [],
  );

  // ⚠️ A LAYOUT effect: a panel opened or folded after paint shows one frame
  // of the old size first.
  // ⚠️ `resize` to the remembered height, never `expand()`. A panel that
  // mounted collapsed has no size to expand back to, and `expand()` then opens
  // it at its 96px minimum — which is what every launch after a hide did.
  useLayoutEffect(() => {
    const panel = terminalRef.current;
    if (!panel) return;
    if (terminalShowing) panel.resize(`${useTerminal.getState().height}%`);
    else panel.collapse();
  }, [terminalShowing, terminalRef]);

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
          {/* ⚠️ The terminal is a panel of the CONTENT column, under whatever
              route is showing — not a route of its own, and not under the
              rail — so it survives every navigation and never covers the
              project switcher (FE-19/D4). Hidden, it folds into the bar below
              the group and stops no shell. */}
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ResizablePanelGroup
                id="lanework:terminal"
                orientation="vertical"
                onLayoutChanged={(layout, { isUserInteraction }) => {
                  if (!isUserInteraction) return;
                  const height = layout.terminal ?? 0;
                  // Dragged shut past its minimum: that is a hide, and the
                  // bar takes over. Any other drag is the height to keep.
                  if (height < 1) setTerminalOpen(false);
                  else setTerminalHeight(height);
                }}
              >
                <ResizablePanel id="content" minSize="20%">
                  <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    <Outlet />
                  </main>
                </ResizablePanel>
                <ResizableHandle
                  aria-label="Resize terminal"
                  className={terminalShowing ? undefined : "hidden"}
                />
                <ResizablePanel
                  id="terminal"
                  panelRef={terminalRef}
                  defaultSize="0%"
                  minSize="96px"
                  maxSize="85%"
                  collapsible
                  collapsedSize="0px"
                >
                  {terminalShowing && workspaceKey && (
                    <TerminalPanel workspace={workspaceKey} />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
            {!terminalShowing && workspaceKey && (
              <TerminalMinibar workspace={workspaceKey} />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CommandPalette />
    </div>
  );
}
