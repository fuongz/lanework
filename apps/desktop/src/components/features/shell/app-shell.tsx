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
import { AgentUsageStrip } from "#/components/features/terminal/agent-usage-strip";
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
import { HistoryButtons } from "./history-nav";

const RAIL_DEFAULT_PX = 240;
/** The rail folded to its icons (FE-58): one 36px slot and its margins. */
const RAIL_MINI_PX = 56;
const RAIL_WIDTH_KEY = "lanework:rail-width";
const RAIL_HIDDEN_KEY = "lanework:rail-hidden";
/** How long the rail glides when its button, ⌘B or focus mode moves it. */
const RAIL_GLIDE_MS = 240;

/**
 * The width the rail comes back at: the last one it was dragged to.
 *
 * ⚠️ Kept here, not only in the group's saved layout. A rail that was last
 * hidden saved THAT, and `expand()` on a panel that mounted collapsed has no
 * size to go back to — it would open at its 180px minimum.
 */
function readRailWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= 180 && saved <= 380) return saved;
  } catch {
    // No storage: the default below.
  }
  return RAIL_DEFAULT_PX;
}

/**
 * Whether the rail was last left hidden: by its button, ⌘B, or a drag.
 *
 * ⚠️ Its own key, because the group's saved layout keeps only what a DRAG
 * did (`onlySaveAfterUserInteractions`): the button and ⌘B hide it through the
 * panel's API, which that save ignores, so a relaunch would have undone it.
 * Focus mode is never written here — it is a mode for a few minutes, not a
 * choice.
 */
function readRailHidden(): boolean | null {
  try {
    const saved = window.localStorage.getItem(RAIL_HIDDEN_KEY);
    return saved === "1" ? true : saved === "0" ? false : null;
  } catch {
    return null;
  }
}

function saveRailHidden(hidden: boolean) {
  try {
    window.localStorage.setItem(RAIL_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Kept for this session only.
  }
}

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
  const navigate = useNavigate();
  const { defaultLayout, onLayoutChanged } = usePersistedLayout(
    "lanework:shell",
    ["sidebar", "main"],
  );
  const focusMode = useLayout((state) => state.focusMode);
  const sidebarRef = usePanelRef();
  const railElement = useRef<HTMLDivElement | null>(null);
  // "Hidden" is the rail FOLDED: since FE-58 that is the mini rail, never
  // nothing at all.
  const [railHidden, setRailHidden] = useState(false);
  const railWidth = useRef(readRailWidth());
  const glideTimer = useRef<number | undefined>(undefined);
  /**
   * Let the NEXT change of the rail's size animate.
   *
   * ⚠️ Only for the button, ⌘B and focus mode — never a drag, which has to
   * follow the pointer exactly, and never the restore at launch. The flag goes
   * on the group's element directly, BEFORE the size changes, so the
   * transition is already in force when the library writes the new
   * `flex-grow`; a React state would land in the same commit as the size and
   * race it.
   *
   * ⚠️ `--rail-w` pins the sidebar's content at its full width while the
   * panel narrows, so it slides out of view behind the edge instead of
   * re-wrapping every label at each frame.
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
   * ⚠️ The folded title bar and the rail's content are choreographed around
   * it, not around the rail's size (FE-58): folding, the title bar starts
   * growing at once, so the page title slides down under it as the rail
   * narrows — switched only once the rail reached 56px, the title jumped
   * left onto the window controls in the last frame. Opening, the open
   * rail's content shows at once and slides in, while the title bar stays
   * until the end, so the title never passes under back and forward.
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
  /** The sidebar button and ⌘B: fold ↔ open (FE-20, FE-58). */
  const toggleRail = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    const hiding = !panel.isCollapsed();
    if (hiding) foldRail();
    else openRail();
    saveRailHidden(hiding);
  }, [sidebarRef, foldRail, openRail]);

  // The rail as it was last LEFT, before the first paint.
  useLayoutEffect(() => {
    const panel = sidebarRef.current;
    const hidden = readRailHidden();
    if (!panel || hidden === null) return;
    if (hidden && !panel.isCollapsed()) panel.collapse();
    else if (!hidden && panel.isCollapsed()) showRail();
  }, [sidebarRef, showRail]);
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

  // Where the sidebar button sits and how far the window controls and it
  // reach, in this page's CSS px (app.css). The controls sit at fixed points
  // while the page zooms, and on current macOS they are the larger ones: 14pt
  // lights 22.5pt apart, the last ending about 79pt in. The button's glyph
  // follows 19pt after that — Codex's spacing — so the 24px button starts at
  // 94pt, centred on their 22pt line; a hidden rail's headers start 12pt after
  // it.
  // ⚠️ Rewritten only when the ZOOM changes (a zoom fires `resize` too), and
  // the zoom is Electron's own — a resize of the window moves none of it.
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
      // The reach up to where the window's own buttons start; app.css adds
      // the buttons themselves, which are fewer while the rail is folded.
      root.style.setProperty("--titlebar-reach-base", `${106 / zoom}px`);
      // The folded window's title bar, as tall as the controls' line needs.
      root.style.setProperty("--titlebar-height", `${44 / zoom}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // The rail's width as it is DRAWN, for the headers' clearance (app.css).
  // ⚠️ From a ResizeObserver, not from React state: the panel changes size
  // straight away, while a re-render lands a frame or more later — and in that
  // frame the header had lost the rail beside it but not yet gained its
  // clearance, so "All issues" flashed under the window controls. A
  // ResizeObserver runs after layout and before paint, so the frame that shows
  // the rail gone also shows the header clear of them.
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

  // View › Toggle Sidebar (⌘B), the same as the button (FE-20/D5).
  useEffect(
    () =>
      window.desktop?.onViewCommand((command) => {
        if (command === "toggle-sidebar") toggleRail();
      }),
    [toggleRail],
  );

  // ⚠️ Driven FROM the store, never the other way round: focus mode is asked
  // for from a pull request's header, in the other panel group. It hides the
  // rail, and leaving it gives back what the rail WAS — a rail somebody had
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
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ⚠️ Folded (FE-58), the window gets a title bar of its own across its
          whole width — the window controls, back and forward — and the mini
          rail and every page start under it, so no header has to step around
          the controls. Shown by app.css off `data-rail-mini`, macOS only. */}
      <div
        aria-hidden="true"
        className="mini-titlebar window-drag-region bg-sidebar border-sidebar-border shrink-0 border-b"
      />
      <ResizablePanelGroup
        className="h-auto min-h-0 flex-1"
        id="lanework:shell"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout, meta) => {
          onLayoutChanged(layout, meta);
          const panel = sidebarRef.current;
          if (!panel) return;
          // ⚠️ Only what somebody DID is remembered. A mount lays the saved
          // layout's percentages over whatever size the window now has, and a
          // window resize or an API call moves the rail too — none of those is
          // a width anybody chose, and writing them down drifted it.
          if (!meta.isUserInteraction) return;
          // Dragged shut, or dragged open: that is where it stays.
          saveRailHidden(panel.isCollapsed());
          // ⚠️ The width to come back at is read HERE, once the drag has let
          // go, and never mid-drag: a drag shut passes through the 180px
          // minimum on its way to nothing, and remembering that would bring
          // the rail back at its narrowest instead of where it was.
          if (panel.isCollapsed()) return;
          const width = Math.round(panel.getSize().inPixels);
          if (width === railWidth.current) return;
          railWidth.current = width;
          try {
            window.localStorage.setItem(RAIL_WIDTH_KEY, String(width));
          } catch {
            // Kept for this session only.
          }
        }}
      >
        {/* ⚠️ Sized in pixels, and `preserve-pixel-size`. A rail is a column of
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
            // its own schedule (`glideTo`); a drag, a launch or a window
            // resize follows the rail's size.
            if (glideTo.current) return;
            const mini = size.inPixels < RAIL_MINI_PX + 1;
            // ⚠️ Written on the root straight away, not through a render: the
            // title bar (app.css) follows it, and a re-render would land a
            // frame after the rail has already moved.
            setMiniFlag(mini);
            setRailHidden(mini);
          }}
        >
          <AppSidebar mini={railHidden} onExpand={toggleRail} />
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
                      usage={<AgentUsageStrip workspace={workspaceKey} />}
                    />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
            {!terminalShowing && workspaceKey && (
              <TerminalMinibar
                workspace={workspaceKey}
                usage={<AgentUsageStrip workspace={workspaceKey} />}
              />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CommandPalette />
      {/* ⚠️ Beside the window controls, the way Codex has it, and there in
          BOTH states: over the rail's title bar while it shows, over the
          header once it is hidden — so the way back is always where the way
          out was. Drawn on macOS only (app.css), where the controls it sits
          beside are.
          ⚠️ LAST in the shell, after every title bar it floats over. Window
          drag regions are laid down in document order and a later one wins:
          placed before the rail, the rail's drag strip was laid over it and
          ate every click — which a test's synthetic click never shows. */}
      <nav aria-label="Window" className="sidebar-nav items-center gap-0.5">
        <HistoryButtons />
        {/* Folded, the sidebar button is the mini rail's first slot (FE-58/D5a)
            and this one is hidden — by app.css, off the same `data-rail-mini`
            the title bar's clearance reads, so the two never disagree for a
            frame; back and forward stay here, beside the window controls. */}
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
    </div>
  );
}
