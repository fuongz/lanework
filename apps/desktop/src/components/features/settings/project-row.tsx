import { useDraggable, useDroppable } from "@dnd-kit/core";
import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { type ReactNode, useCallback } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { cn } from "#/lib/utils";

/** `slugs` with `slug` moved to where `over` is (FE-32). */
export function moveSlug(
  slugs: string[],
  slug: string,
  over: string,
): string[] {
  const from = slugs.indexOf(slug);
  const to = slugs.indexOf(over);
  if (from < 0 || to < 0 || from === to) return slugs;
  const next = [...slugs];
  next.splice(from, 1);
  next.splice(to, 0, slug);
  return next;
}

/**
 * How far row `index` steps aside while the row at `from` hovers over `to`:
 * one lifted row's height, toward the gap it leaves (FE-32).
 */
export function shiftFor(
  index: number,
  drag: { from: number; to: number; height: number } | null,
): number {
  if (!drag || index === drag.from) return 0;
  if (drag.from < drag.to && index > drag.from && index <= drag.to)
    return -drag.height;
  if (drag.to < drag.from && index >= drag.to && index < drag.from)
    return drag.height;
  return 0;
}

const glide = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * One project in Settings → Projects, with the grip that puts it in order
 * (FE-32). Its number is its place, and its ⌘ shortcut in the switcher.
 *
 * ⚠️ The same drag as the terminal's tab strip (`terminal-tab.tsx`):
 * `useDraggable` + `useDroppable` per row rather than `@dnd-kit/sortable`, a
 * y-only transform, Motion `layout` off mid-drag and on at the drop. The order
 * changes only at the drop; until then the rows the lifted one passes slide
 * out of its way by `shift`, so the list shows where it will land.
 *
 * ⚠️ Only the GRIP drags (D5). The rest of the row is already a button — the
 * one that picks which project this page manages — and a row that dragged from
 * anywhere would turn a slightly shaky click on it into a move.
 */
export function ProjectRow({
  workspace,
  index,
  selected,
  shift,
  canMove,
  onMove,
  children,
}: {
  workspace: Workspace;
  index: number;
  selected: boolean;
  /** Px this row steps aside for the one being dragged (`shiftFor`). */
  shift: number;
  /** False while the order cannot be saved (a project with no cloud id). */
  canMove: boolean;
  /** Alt+↑ / Alt+↓ on the focused grip: the keyboard path for the same move. */
  onMove: (delta: -1 | 1) => void;
  children: ReactNode;
}) {
  const drag = useDraggable({ id: workspace.slug, disabled: !canMove });
  const { setNodeRef: setDragNode } = drag;
  const { setNodeRef: setDropNode } = useDroppable({ id: workspace.slug });
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNode(node);
      setDropNode(node);
    },
    [setDragNode, setDropNode],
  );

  return (
    <motion.div
      ref={setRefs}
      layout={!drag.isDragging}
      initial={false}
      // One `y` for both roles: under the pointer while lifted (no easing, or
      // it lags the cursor), and a glide otherwise — out of the way mid-drag,
      // and from where it was dropped into its slot, the layout move and the
      // `y` returning to 0 running on the same curve.
      animate={{ y: drag.isDragging ? (drag.transform?.y ?? 0) : shift }}
      transition={drag.isDragging ? { duration: 0 } : glide}
      data-project-row={workspace.slug}
      className={cn(
        "flex items-center gap-3 py-3.5 pr-4 pl-2 transition-colors",
        // Lifted, every row is the same small card, all four corners round —
        // the first row's `rounded-t` alone read as a different kind of row.
        drag.isDragging
          ? "bg-card relative z-10 rounded-xl shadow-card"
          : cn(
              "first:rounded-t-xl last:rounded-b-xl",
              selected && "bg-foreground/[0.03]",
            ),
      )}
    >
      <button
        ref={drag.setActivatorNodeRef}
        {...drag.listeners}
        type="button"
        disabled={!canMove}
        aria-label={`Move ${workspace.name}, position ${index + 1}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title={
          canMove
            ? "Drag to reorder — or Alt+↑ / Alt+↓"
            : "This project has no cloud id yet, so the order cannot be saved."
        }
        onKeyDown={(event) => {
          if (!event.altKey) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        className="text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground grid h-8 w-5 shrink-0 cursor-grab place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <HugeiconsIcon
          icon={DragDropVerticalIcon}
          className="size-4"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      <span
        aria-hidden="true"
        className="text-muted-foreground w-4 shrink-0 text-right text-[13px] tabular-nums"
      >
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-6">
        {children}
      </div>
    </motion.div>
  );
}
