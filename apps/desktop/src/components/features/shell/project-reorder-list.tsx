import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { moveSlug, shiftFor } from "#/components/features/settings/project-row";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { ProjectTile } from "#/components/shared/common/project-tile";
import { cn } from "#/lib/utils";
import { isLocalWorkspace } from "#/stores/session";

const glide = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * One project while the switcher is in reorder mode.
 *
 * The whole row drags here, unlike Settings → Projects (`ProjectRow`), where
 * only the grip does. In this mode a row has no click of its own (it does not
 * open the project), so there is no click for a drag to steal.
 */
function ReorderRow({
  workspace,
  index,
  shift,
  onMove,
}: {
  workspace: Workspace;
  index: number;
  shift: number;
  onMove: (delta: -1 | 1) => void;
}) {
  const drag = useDraggable({ id: workspace.slug });
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
      {...drag.listeners}
      {...drag.attributes}
      layout={!drag.isDragging}
      initial={false}
      animate={{ y: drag.isDragging ? (drag.transform?.y ?? 0) : shift }}
      transition={drag.isDragging ? { duration: 0 } : glide}
      aria-label={`Move ${workspace.name}, position ${index + 1}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onKeyDown={(event) => {
        if (!event.altKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        onMove(event.key === "ArrowUp" ? -1 : 1);
      }}
      className={cn(
        "focus-visible:bg-foreground/[0.08] flex h-7 shrink-0 cursor-grab touch-none items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-none select-none active:cursor-grabbing",
        drag.isDragging
          ? "bg-popover shadow-card relative z-10"
          : "hover:bg-foreground/[0.05]",
      )}
    >
      <ProjectTile
        workspace={workspace}
        className="size-5 rounded-[5px] text-[10px]"
      />
      <span className="truncate">{workspace.name}</span>
      {isLocalWorkspace(workspace) && <LocalBadge />}
      <HugeiconsIcon
        icon={DragDropVerticalIcon}
        className="text-muted-foreground ml-auto size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </motion.div>
  );
}

/**
 * The switcher's project list as a drag-to-reorder list, from the Reorder
 * entry in its sort menu.
 *
 * The same order Settings → Projects edits, ⌘1…⌘9 follow, and the "Default"
 * sort shows. It is saved at each drop.
 */
export function ProjectReorderList({
  workspaces,
  onReorder,
}: {
  workspaces: Workspace[];
  onReorder: (slugs: string[]) => void;
}) {
  const slugs = workspaces.map((entry) => entry.slug);
  // A small threshold, so a press that does not move is not a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [dragging, setDragging] = useState<{
    from: number;
    to: number;
    height: number;
  } | null>(null);
  const onDragStart = (event: DragStartEvent) => {
    const from = slugs.indexOf(String(event.active.id));
    setDragging({ from, to: from, height: 0 });
  };
  const onDragOver = (event: DragOverEvent) => {
    const over = event.over ? slugs.indexOf(String(event.over.id)) : -1;
    // NOTE: Measured here, not in `onDragStart`; see `workspaces-section.tsx`.
    // Plus the list's 2px gap, so the rows step aside by a whole slot.
    const height = (event.active.rect.current.initial?.height ?? 0) + 2;
    setDragging(
      (now) => now && { ...now, height, to: over < 0 ? now.from : over },
    );
  };
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over?.id;
    if (over && over !== event.active.id)
      onReorder(moveSlug(slugs, String(event.active.id), String(over)));
    setDragging(null);
  };
  const listRef = useRef<HTMLDivElement>(null);
  // Up and down inside the list: a row cannot be lifted out of the menu.
  const alongList: Modifier = useCallback(({ transform, draggingNodeRect }) => {
    const bounds = listRef.current?.getBoundingClientRect();
    if (!bounds || !draggingNodeRect) return { ...transform, x: 0 };
    const y = Math.min(
      bounds.bottom - draggingNodeRect.bottom,
      Math.max(bounds.top - draggingNodeRect.top, transform.y),
    );
    return { ...transform, x: 0, y };
  }, []);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
      modifiers={[alongList]}
    >
      <div ref={listRef} className="flex flex-col gap-0.5">
        {workspaces.map((workspace, index) => (
          <ReorderRow
            key={workspace.slug}
            workspace={workspace}
            index={index}
            shift={shiftFor(index, dragging)}
            onMove={(delta) => {
              const to = slugs[index + delta];
              if (to) onReorder(moveSlug(slugs, workspace.slug, to));
            }}
          />
        ))}
      </div>
    </DndContext>
  );
}
