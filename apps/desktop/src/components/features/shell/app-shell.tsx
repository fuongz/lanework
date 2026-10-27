import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import { PortsStrip } from "#/components/features/terminal/ports-strip";
import { TerminalMinibar } from "#/components/features/terminal/terminal-minibar";
import { TerminalPanel } from "#/components/features/terminal/terminal-panel";
import { useTerminalSessions } from "#/components/features/terminal/use-terminal-sessions";
import { HarnessIsland } from "#/components/shared/agents/harness-island";
import { WindowTitlebarHost } from "#/components/shared/navigation/window-titlebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { usePersistedLayout } from "#/hooks/use-persisted-layout";
import { readStored, writeStored } from "#/lib/stored";
import { useBoard } from "#/stores/board";
import { useLayout } from "#/stores/layout";
import { useMcpAuthWatch } from "#/stores/mcp-auth";
import { terminalShown, useTerminal } from "#/stores/terminal";
import { AgentUsageStrip } from "./agent-usage-strip";
import { AppSidebar } from "./app-sidebar";
import { BoardNoticeIsland, useBoardNotice } from "./board-notice-island";
import { CommandPalette } from "./command-palette";
import { DictationIsland, useDictationUp } from "./dictation-island";
import { HistoryButtons } from "./history-nav";
import { McpAuthIsland, useMcpAuthRows } from "./mcp-auth-island";

const RAIL_DEFAULT_PX = 240;
/** The rail folded to its icons: one 36px slot and its margins. */
const RAIL_MINI_PX = 56;
const RAIL_WIDTH_KEY = "lanework:rail-width";
const RAIL_HIDDEN_KEY = "lanework:rail-hidden";
/** How long the rail glides when its button, ⌘B or focus mode moves it. */
const RAIL_GLIDE_MS = 240;

/**
 * The width the rail comes back at: the last one it was dragged to.
 *
 * NOTE: Kept here, not only in the group's saved layout. A rail last hidden
 * saved that, and `expand()` on a panel that mounted collapsed has no size to
 * go back to: it would open at its 180px minimum.
 */
function readRailWidth(): number {
  const saved = Number(readStored(RAIL_WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= 180 && saved <= 380) return saved;
  return RAIL_DEFAULT_PX;
}

/**
 * Whether the rail was last left hidden: by its button, ⌘B, or a drag.
 *
 * Its own key, because the group's saved layout keeps only what a drag did
 * (`onlySaveAfterUserInteractions`). The button and ⌘B hide it through the
 * panel's API, which that save ignores, so a relaunch would undo it. Focus
 * mode is never written here: it is a mode for a few minutes, not a choice.
 */
function readRailHidden(): boolean | null {
  const saved = readStored(RAIL_HIDDEN_KEY);
  return saved === "1" ? true : saved === "0" ? false : null;
}

function saveRailHidden(hidden: boolean) {
  writeStored(RAIL_HIDDEN_KEY, hidden ? "1" : "0");
}

/**
 * The window: a rail beside one scrolling pane.
 *
 * - Only the pane scrolls. A shell that scrolls as a whole takes the project
 *   switcher and the lane list off screen the moment a board is long, which
 *   is the one thing a persistent sidebar exists to prevent.
 * - The rail is a panel, not a fixed `w-60`, so it is draggable on every
 *   route. A sidebar that resizes under Pull requests and is frozen under
 *   Issues reads as a bug.
 */
export function AppShell() {
  const navigate = useNavigate();
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:shell",
    ["sidebar", "main"],
  );
  const focusMode = useLayout((state) => state.focusMode);
  const sidebarRef = usePanelRef();
  const railElement = useRef<HTMLDivElement | null>(null);
  // "Hidden" is the rail folded to the mini rail, never gone altogether.
  const [railHidden, setRailHidden] = useState(false);
  const railWidth = useRef(readRailWidth());
  const glideTimer = useRef<number | undefined>(undefined);
  /**
   * Let the next change of the rail's size animate.
   *
   * Only for the button, ⌘B and focus mode: never a drag, which has to follow
   * the pointer, and never the restore at launch.
   *
   * - NOTE: The flag goes on the group's element directly, before the size
   *   changes, so the transition is in force when the library writes the new
   *   `flex-grow`. A React state would land in the same commit as the size
   *   and race it.
   * - `--rail-w` pins the sidebar's content at its full width while the panel
   *   narrows, so it slides out behind the edge instead of re-wrapping every
   *   label at each frame.
   */
  const glide = useCallback(() => {
    const group = railElement.current?.parentElement;
    if (!group) return;
    group.style.setProperty("--rail-w", `${railWidth.current}px`);
    group.dataset.railGliding = "true";
    window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => {
      delete group.dataset.railGliding;
    }, RAIL_GLIDE_MS + 60);
  }, []);
  useEffect(() => () => window.clearTimeout(glideTimer.current), []);
  const showRail = useCallback(() => {
    sidebarRef.current?.resize(`${railWidth.current}px`);
  }, [sidebarRef]);
  /**
   * Where a glide by the button, ⌘B or focus mode is headed, while it runs.
   *
   * The folded flag (`data-rail-mini`) and the rail's content are
   * choreographed around it, not around the rail's size:
   * - folding, the flag goes on at once, so the title bar's rule fades and
   *   its slot clears back and forward while the rail narrows;
   * - opening, the open rail's content shows at once and slides in, while the
   *   flag stays until the end, so the sidebar button never pops in
   *   mid-glide.
   */
  const glideTo = useRef<"mini" | "open" | null>(null);
  const glideEnd = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(glideEnd.current), []);
  const setMiniFlag = useCallback((on: boolean) => {
    if (on) document.documentElement.dataset.railMini = "true";
    else delete document.documentElement.dataset.railMini;
  }, []);
  const foldRail = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel || panel.isCollapsed()) return;
    glide();
    glideTo.current = "mini";
    setMiniFlag(true);
    window.clearTimeout(glideEnd.current);
    glideEnd.current = window.setTimeout(() => {
      glideTo.current = null;
      setRailHidden(true);
    }, RAIL_GLIDE_MS);
    panel.collapse();
  }, [sidebarRef, glide, setMiniFlag]);
  const openRail = useCallback(() => {
    glide();
    glideTo.current = "open";
    setRailHidden(false);
    window.clearTimeout(glideEnd.current);
    glideEnd.current = window.setTimeout(() => {
      glideTo.current = null;
      setMiniFlag(false);
    }, RAIL_GLIDE_MS);
    showRail();
  }, [glide, showRail, setMiniFlag]);
  /** The sidebar button and ⌘B: fold ↔ open. */
  const toggleRail = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    const hiding = !panel.isCollapsed();
    if (hiding) foldRail();
    else openRail();
    saveRailHidden(hiding);
  }, [sidebarRef, foldRail, openRail]);

  // The rail as it was last left, before the first paint.
  useLayoutEffect(() => {
    const panel = sidebarRef.current;
    const hidden = readRailHidden();
    if (!panel || hidden === null) return;
    if (hidden && !panel.isCollapsed()) panel.collapse();
    else if (!hidden && panel.isCollapsed()) showRail();
  }, [sidebarRef, showRail]);
  const terminalRef = usePanelRef();
  const notice = useBoardNotice();
  const dictating = useDictationUp();
  // Whether Claude Code and Codex are signed in to the cloud Lanework MCP,
  // asked again on a timer and on focus; the island speaks when they are not.
  useMcpAuthWatch();
  const mcpAuthUp = useMcpAuthRows().length > 0;
  // The project in the URL, not the board store's `active`: on the project
  // picker there is no project, so no terminal (neither the panel nor its
  // bar) rather than whichever project's was open last.
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
        if (typeof command === "object" && command.type === "focus") {
          if (command.shellId) {
            terminal.select(command.workspace, command.shellId);
            terminal.setOpen(command.workspace, true);
          }
          void navigate({ href: command.href });
        } else if (command === "toggle") void terminal.toggle(keyRef.current);
        else void terminal.newTerminal(keyRef.current);
      }),
    [navigate],
  );

  // NOTE:
  // - A layout effect: a panel opened or folded after paint shows one frame
  //   of the old size first.
  // - `resize` to the remembered height, never `expand()`. A panel that
  //   mounted collapsed has no size to expand back to, and `expand()` then
  //   opens it at its 96px minimum.
  useLayoutEffect(() => {
    const panel = terminalRef.current;
    if (!panel) return;
    if (terminalShowing) panel.resize(`${useTerminal.getState().height}%`);
    else panel.collapse();
  }, [terminalShowing, terminalRef]);

  // Where back, forward and the sidebar button sit, and how tall the title
  // bar is, in this page's CSS px (app.css). The window controls sit at fixed
  // points while the page zooms, and on current macOS they are the larger
  // ones: 14pt lights 22.5pt apart, the last ending about 79pt in. The first
  // button's glyph follows 19pt after that (Codex's spacing), so the 24px
  // button starts at 94pt, centred on their 22pt line, as is the 44pt title
  // bar.
  //
  // Rewritten only when the zoom changes (a zoom fires `resize` too). The
  // zoom is Electron's own; resizing the window moves none of it.
  useEffect(() => {
    const root = document.documentElement;
    let applied = 0;
    const update = () => {
      // `?.()`: a window still running an older preload has no `zoomFactor`,
      // and throwing here would leave the previous numbers in place.
      const zoom = window.desktop?.zoomFactor?.() || 1;
      if (zoom === applied) return;
      applied = zoom;
      root.style.setProperty("--sidebar-toggle-left", `${94 / zoom}px`);
      root.style.setProperty("--sidebar-toggle-top", `${22 / zoom - 12}px`);
      // The window's title bar, as tall as the controls' line needs.
      root.style.setProperty("--titlebar-height", `${44 / zoom}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // The rail's width as it is drawn, for the title bar's rule and slot and
  // for back and forward (app.css).
  //
  // NOTE: From a ResizeObserver, not React state. The panel changes size at
  // once, while a re-render lands a frame or more later; in that frame the
  // page's title has lost the rail beside it but not yet gained its
  // clearance, so "All issues" flashes under the window controls. A
  // ResizeObserver runs after layout and before paint, so the frame that
  // shows the rail gone also shows the title clear of them.
  useEffect(() => {
    const rail = railElement.current;
    if (!rail) return;
    const root = document.documentElement;
    const watch = new ResizeObserver(([entry]) => {
      if (entry)
        root.style.setProperty("--rail-width", `${entry.contentRect.width}px`);
    });
    watch.observe(rail);
    return () => watch.disconnect();
  }, []);

  // View › Toggle Sidebar (⌘B), the same as the button (FE-19/D5), and
  // Settings (⌘,).
  useEffect(
    () =>
      window.desktop?.onViewCommand((command) => {
        if (command === "toggle-sidebar") toggleRail();
        else if (command === "open-settings")
          void navigate({ to: "/settings" });
      }),
    [toggleRail, navigate],
  );

  // Driven from the store, never the other way round: focus mode is asked for
  // from a pull request's header, in the other panel group. It hides the
  // rail, and leaving it gives back what the rail was: a rail somebody had
  // already hidden stays hidden.
  const railBeforeFocus = useRef<"hidden" | "shown" | null>(null);
  useEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (focusMode) {
      railBeforeFocus.current = panel.isCollapsed() ? "hidden" : "shown";
      foldRail();
    } else if (railBeforeFocus.current) {
      if (railBeforeFocus.current === "shown") openRail();
      railBeforeFocus.current = null;
    }
  }, [focusMode, sidebarRef, foldRail, openRail]);

  return (
    // The window's ground is the rail's colour, and the page sits on it as an
    // inset card. The card's border is the edge between the two, so the
    // separator below draws nothing until it is pointed at.
    <div className="bg-sidebar flex h-screen flex-col overflow-hidden">
      {/* The window's title bar across its whole width, open or folded: the
          window controls, back and forward over the rail, and the page's
          header (`<WindowTitlebar>`) beside them. The rail and the page's
          card start under it, so no header has to step around the controls.
          `app-titlebar` keeps its slot clear of back and forward too
          (app.css). */}
      <WindowTitlebarHost className="app-titlebar" />
      <ResizablePanelGroup
        className="h-auto min-h-0 flex-1"
        id="lanework:shell"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout, meta) => {
          onLayoutChanged(layout, meta);
          const panel = sidebarRef.current;
          if (!panel) return;
          // NOTE: Only what somebody did is remembered. A mount lays the saved
          // layout's percentages over whatever size the window now has, and a
          // window resize or an API call moves the rail too. None of those is
          // a width anybody chose, and writing them down drifts it.
          if (!meta.isUserInteraction) return;
          // Dragged shut, or dragged open: that is where it stays.
          saveRailHidden(panel.isCollapsed());
          // NOTE: The width to come back at is read here, once the drag has
          // let go, never mid-drag. A drag shut passes through the 180px
          // minimum on its way to nothing, and remembering that would bring
          // the rail back at its narrowest instead of where it was.
          if (panel.isCollapsed()) return;
          const width = Math.round(panel.getSize().inPixels);
          if (width === railWidth.current) return;
          railWidth.current = width;
          writeStored(RAIL_WIDTH_KEY, String(width));
        }}
      >
        {/* Sized in pixels, and `preserve-pixel-size`. A rail is a column of
            labels, not a proportion of the window: held as a percentage it
            grows into empty space every time somebody maximises the window. */}
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarRef}
          elementRef={railElement}
          defaultSize="240px"
          minSize="180px"
          maxSize="380px"
          collapsible
          collapsedSize={`${RAIL_MINI_PX}px`}
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            // A glide by the button, ⌘B or focus mode sets these itself, on
            // its own schedule (`glideTo`). A drag, a launch or a window
            // resize follows the rail's size.
            if (glideTo.current) return;
            const mini = size.inPixels < RAIL_MINI_PX + 1;
            // NOTE: Written on the root at once, not through a render: the
            // title bar (app.css) follows it, and a re-render would land a
            // frame after the rail has already moved.
            setMiniFlag(mini);
            setRailHidden(mini);
          }}
        >
          <AppSidebar mini={railHidden} onExpand={toggleRail} />
        </ResizablePanel>
        <ResizableHandle
          aria-label="Resize sidebar"
          className="bg-transparent"
        />
        <ResizablePanel id="main" minSize="40%">
          {/* The terminal is a panel of the content column, under whatever
              route is showing: not a route of its own, and not under the
              rail. So it survives every navigation and never covers the
              project switcher (FE-18/D4). Hidden, it folds into the bar below
              the group and stops no shell. */}
          {/* `overflow-hidden` clips the page, the terminal and its bar to
              the card's corners; each still scrolls on its own. */}
          <div className="bg-background my-1.5 mr-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-panel-edge">
            <div className="min-h-0 flex-1">
              <ResizablePanelGroup
                id="lanework:terminal"
                orientation="vertical"
                onLayoutChanged={(layout, { isUserInteraction }) => {
                  if (!isUserInteraction) return;
                  const height = layout.terminal ?? 0;
                  // Dragged shut past its minimum: that is a hide, and the
                  // bar takes over. Any other drag is the height to keep.
                  if (height < 1) {
                    if (workspaceKey) setTerminalOpen(workspaceKey, false);
                  } else setTerminalHeight(height);
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
                    <TerminalPanel
                      workspace={workspaceKey}
                      usage={<BarStrips workspace={workspaceKey} />}
                    />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
            {!terminalShowing && workspaceKey && (
              <TerminalMinibar
                workspace={workspaceKey}
                usage={<BarStrips workspace={workspaceKey} />}
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CommandPalette />
      {/* In the window's title bar, the way Codex has it, in both states:
          against the rail's edge while it is open, beside the window
          controls once it is folded, so the way back is always where the way
          out was. Drawn on macOS only (app.css), where those controls are.

          NOTE: Last in the shell, after every title bar it floats over.
          Window drag regions are laid down in document order and a later one
          wins: placed before the rail, the rail's drag strip lies over it and
          eats every click, which a test's synthetic click never shows. */}
      <nav aria-label="Window" className="sidebar-nav items-center gap-0.5">
        <HistoryButtons />
        {/* Folded, the sidebar button is the mini rail's first slot
            (FE-57/D5a) and this one is hidden by app.css, off the same
            `data-rail-mini` the title bar's slot reads, so the two never
            disagree for a frame. Back and forward stay here, beside the
            window controls. */}
        <button
          type="button"
          onClick={toggleRail}
          aria-label={railHidden ? "Show sidebar" : "Hide sidebar"}
          title={`${railHidden ? "Show" : "Hide"} sidebar (⌘B)`}
          className="sidebar-toggle text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground size-6 place-items-center rounded-md transition-colors duration-150"
        >
          <HugeiconsIcon
            icon={SidebarLeftIcon}
            className="size-4"
            strokeWidth={1.6}
            aria-hidden="true"
          />
        </button>
      </nav>
      {/* The islands (harness updates, board notices, the Lanework MCP
          sign-in, dictation), fixed at the top centre over the title bar's
          edge and the page. One spot, one island: an open microphone has it,
          then a notice, then sign-in, and the harness pill waits for all of
          them.

          NOTE: After the nav for the same reason as the nav: their `no-drag`
          must be laid down after the title bar's drag strip, or the strip
          eats their clicks. */}
      <HarnessIsland yieldTo={dictating || notice !== null || mcpAuthUp} />
      <McpAuthIsland yieldTo={dictating || notice !== null} />
      <BoardNoticeIsland notice={dictating ? null : notice} />
      <DictationIsland />
    </div>
  );
}

/**
 * The terminal bar's right end: listening ports, then the agent's usage,
 * with a hairline between them.
 *
 * The line is drawn by the second item present, not placed between them:
 * either strip draws nothing when it has nothing to say, and a line beside
 * one strip alone would divide nothing.
 */
function BarStrips({ workspace }: { workspace: string }) {
  return (
    <div className="flex items-center gap-3 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:top-1/2 [&>*+*]:before:-left-1.5 [&>*+*]:before:h-3.5 [&>*+*]:before:w-px [&>*+*]:before:-translate-y-1/2 [&>*+*]:before:bg-border">
      <PortsStrip workspace={workspace} />
      <AgentUsageStrip workspace={workspace} />
    </div>
  );
}
