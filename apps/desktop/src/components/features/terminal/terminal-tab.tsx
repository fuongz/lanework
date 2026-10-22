import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Cancel01Icon,
  Folder01Icon,
  Home01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useCallback } from "react";
import type { TerminalSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

/** The last segment of a path, or `~` for a terminal with no project folder. */
function folderOf(session: TerminalSession): string {
  if (!session.cwd) return "~";
  return session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd;
}

/**
 * One terminal's tab: pick it, close it, or drag it to another place.
 *
 * The drag is agents-kanban's tab-strip setup, not a new one: `useDraggable`
 * and `useDroppable` on each tab rather than `@dnd-kit/sortable` for a single
 * row, an x-only transform, and Motion `layout` off mid-drag and on at drop
 * so the strip animates once. The order changes only at the drop: a live
 * swap re-measures tabs that are in the middle of moving.
 *
 * NOTE: The drag handle is the tab's own button, and the × is its sibling,
 * never inside it. A button in a button is invalid HTML, and a × that shared
 * the handle would turn a slightly shaky click on it into a drag.
 */
export function TerminalTab({
  session,
  index,
  current,
  onSelect,
  onClose,
  onMove,
}: {
  session: TerminalSession;
  index: number;
  current: boolean;
  onSelect: () => void;
  onClose: () => void;
  /** ⌥⌘← / ⌥⌘→ on the focused tab: the keyboard path for the same move. */
  onMove: (delta: -1 | 1) => void;
}) {
  const drag = useDraggable({ id: session.id });
  const { setNodeRef: setDragNode } = drag;
  const { setNodeRef: setDropNode } = useDroppable({ id: session.id });
  const setRefs = useCallback(
    (node: HTMLLIElement | null) => {
      setDragNode(node);
      setDropNode(node);
    },
    [setDragNode, setDropNode],
  );

  return (
    <motion.li
      ref={setRefs}
      // No reduced-motion branch here: the root's `MotionConfig
      // reducedMotion="user"` already drops the layout glide, and the tab
      // following the pointer is the drag itself, not an animation. The
      // board's cards follow it the same way.
      layout={!drag.isDragging}
      style={{ x: drag.transform?.x ?? 0 }}
      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "group flex h-6 shrink-0 items-center rounded-md text-xs transition-colors",
        // The tab in hand is the button's `secondary` variant: no ring, no
        // shadow, and nothing drawn on the tab it is over. The strip glides
        // into its new order at the drop, which says where it went. It is
        // lifted above its neighbours, though: this is the tab itself,
        // following the pointer, with no overlay.
        drag.isDragging
          ? "bg-secondary text-secondary-foreground relative z-10"
          : current
            ? "bg-foreground/[0.07] text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
      )}
    >
      <button
        ref={drag.setActivatorNodeRef}
        // NOTE: `listeners` without dnd-kit's `attributes`, as on the board.
        // The attributes add a tabstop and a role this button already has.
        {...drag.listeners}
        type="button"
        aria-current={current ? "true" : undefined}
        aria-keyshortcuts="Alt+Meta+ArrowLeft Alt+Meta+ArrowRight"
        title={
          session.cwd ?? "No project folder on this machine — started in ~"
        }
        onClick={onSelect}
        onKeyDown={(event) => {
          // On the tab, not a window binding: a focused tab is the only thing
          // that answers "which one moves". A global shortcut would have to
          // guess while the cursor sits in a shell.
          if (!event.altKey || !(event.metaKey || event.ctrlKey)) return;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onMove(event.key === "ArrowLeft" ? -1 : 1);
        }}
        className="flex h-full max-w-56 items-center gap-1.5 pr-1 pl-2 outline-none"
      >
        <TerminalKindIcon kind={session.kind} className="size-3.5 shrink-0" />
        {/* A shell by its own name; an agent tab by the agent's, which is
            what it was opened for; the shell under it is a detail. */}
        <span className="shrink-0">
          {session.kind === "shell"
            ? session.shell
            : TERMINAL_KIND_LABELS[session.kind]}
        </span>
        {/* Where it runs, said with a mark rather than a "·" between words:
            a folder for the project's, a house for `~` when this machine has
            no folder for the project. The tooltip spells that out, and a
            screen reader is told in words. */}
        <span className="flex min-w-0 items-center gap-1 opacity-70">
          <HugeiconsIcon
            icon={session.cwd ? Folder01Icon : Home01Icon}
            className="size-3 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="sr-only">in</span>
          <span className="truncate">{folderOf(session)}</span>
          {!session.cwd && <span className="sr-only">(no project folder)</span>}
        </span>
        {session.exit && (
          <Badge variant="secondary" className="h-4 shrink-0 px-1.5">
            exited
          </Badge>
        )}
      </button>
      <button
        type="button"
        aria-label={`Close terminal ${index + 1}`}
        onClick={onClose}
        className="hover:bg-foreground/[0.08] mr-1 grid size-4 place-items-center rounded-sm opacity-60 group-hover:opacity-100"
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="size-3"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
    </motion.li>
  );
}
