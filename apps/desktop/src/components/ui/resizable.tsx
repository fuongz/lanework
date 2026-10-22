import { cn } from "cn";
import {
  Group,
  type GroupProps,
  type LayoutStorage,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
  useDefaultLayout,
} from "react-resizable-panels";

// Columns a person can drag.
//
// - NOTE: Written against `react-resizable-panels` v4, whose components are
//   `Group` / `Panel` / `Separator`. shadcn's published `resizable` block
//   wraps `PanelGroup` / `PanelResizeHandle` from v2; pasting it here would
//   import names this version does not export.
// - The separator is a real `role="separator"` with the WAI-ARIA properties
//   the library maintains, which is the reason to take the dependency: arrow
//   keys resize it, Home/End jump to the extremes, and double-click restores
//   the default size. A div with a pointer handler gives none of that, and
//   these panes are the only navigation some screens have.

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      // NOTE: No `flex-row` / `flex-col` here. The library sets `display` and
      // `flexDirection` inline from `orientation`, and its inline styles
      // cannot be overridden; a class stating the direction would lose
      // silently or fight it.
      className={cn("h-full w-full", className)}
      {...props}
    />
  );
}

function ResizablePanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      // `min-w-0` because every pane scrolls its own content: a panel whose
      // child cannot shrink below its intrinsic width pushes the separator
      // past the window's edge, out of reach.
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      {...props}
    />
  );
}

/**
 * The line between two panels.
 *
 * One pixel to look at, nine to hit. The `after:` pseudo-element widens the
 * grab target without taking layout space; people miss a one-pixel target
 * and conclude the panel does not resize at all.
 */
function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "bg-panel-rule relative shrink-0 transition-colors",
        "hover:bg-accent-brand/60 active:bg-accent-brand",
        "focus-visible:bg-accent-brand focus-visible:outline-none",
        // The separator in a horizontal group is a vertical rule, and the
        // library states that on the element itself.
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=vertical]:after:absolute aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:-left-1 aria-[orientation=vertical]:after:w-[9px] aria-[orientation=vertical]:after:content-['']",
        "aria-[orientation=horizontal]:h-px",
        "aria-[orientation=horizontal]:after:absolute aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:-top-1 aria-[orientation=horizontal]:after:h-[9px] aria-[orientation=horizontal]:after:content-['']",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Storage for column widths that may be unavailable.
 *
 * NOTE: Every read and write is wrapped, and the fallback is an in-memory map
 * rather than `undefined`. Handing the hook nothing makes it reach for
 * `localStorage` itself, which is what just threw. A layout that forgets is
 * an annoyance; an exception during render is a blank window.
 */
function layoutStorage(): LayoutStorage {
  const memory = new Map<string, string>();
  return {
    getItem: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
  };
}

/**
 * Remembered column widths.
 *
 * - `localStorage`, not the main process: one window's display preference is
 *   not account data and not worth an IPC round trip per drag.
 *   `stores/preferences.ts` keeps renderer preferences the same way.
 * - NOTE: `onlySaveAfterUserInteractions` matters. Without it, collapsing a
 *   panel from a button, or resizing the window, overwrites the width someone
 *   dragged to.
 */
export function usePersistedLayout(id: string, panelIds: string[]) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    panelIds,
    storage: layoutStorage(),
    onlySaveAfterUserInteractions: true,
  });
  return { defaultLayout, onLayoutChanged };
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
