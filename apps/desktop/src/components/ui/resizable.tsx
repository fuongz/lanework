import {
  DragDropHorizontalIcon,
  DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import {
  Group,
  type GroupProps,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
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
 * The line between two panels, and a grip in its middle.
 *
 * The line keeps its quiet colour; hovering, dragging or focusing the
 * separator shows a small grip at its centre instead of lighting the whole
 * line. Nine pixels to hit: the `after:` pseudo-element widens the grab
 * target without taking layout space, since people miss a one-pixel target
 * and conclude the panel does not resize at all.
 */
function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "group/handle bg-panel-rule relative shrink-0 focus-visible:outline-none",
        // The separator in a horizontal group is a vertical rule, and the
        // library states that on the element itself.
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=vertical]:after:absolute aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:-left-1 aria-[orientation=vertical]:after:w-[9px] aria-[orientation=vertical]:after:content-['']",
        "aria-[orientation=horizontal]:h-px",
        "aria-[orientation=horizontal]:after:absolute aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:-top-1 aria-[orientation=horizontal]:after:h-[9px] aria-[orientation=horizontal]:after:content-['']",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "bg-popover border-border text-muted-foreground pointer-events-none absolute top-1/2 left-1/2 z-10 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md border shadow-sm",
          // The library's own state (`data-separator`): hover, active while
          // dragging, focus from the keyboard; a disabled one never shows.
          "opacity-0 transition-opacity duration-150 group-data-[separator=active]/handle:opacity-100 group-data-[separator=focus]/handle:opacity-100 group-data-[separator=hover]/handle:opacity-100",
          "group-aria-[orientation=vertical]/handle:h-6 group-aria-[orientation=vertical]/handle:w-3.5",
          "group-aria-[orientation=horizontal]/handle:h-3.5 group-aria-[orientation=horizontal]/handle:w-6",
        )}
      >
        <HugeiconsIcon
          icon={DragDropVerticalIcon}
          className="hidden size-3 group-aria-[orientation=vertical]/handle:block"
          strokeWidth={2}
        />
        <HugeiconsIcon
          icon={DragDropHorizontalIcon}
          className="hidden size-3 group-aria-[orientation=horizontal]/handle:block"
          strokeWidth={2}
        />
      </span>
    </Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
