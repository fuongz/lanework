import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Archive02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { REVIEW_COLUMNS, type ReviewCard, type ReviewColumn } from "@/lib/github";
import { STATUS_META } from "@/lib/review-status";
import { cn } from "@/lib/utils";
import type { BoardData } from "@/server/reviews";
import { setCardStatus } from "@/server/reviews";
import { KanbanCard } from "./kanban-card";
import { KanbanColumn } from "./kanban-column";

type Cards = BoardData["cards"];
const EMPTY = new Set<string>();

const ZONE_DONE = "zone-done";
const ZONE_ARCHIVE = "zone-dropped"; // status value stays `dropped`, shown as "Archived"

// Prioritize the top/bottom drop zones: if the pointer is within one, it wins over
// whatever column sits behind it.
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const zone = hits.find((h) => h.id === ZONE_DONE || h.id === ZONE_ARCHIVE);
  return zone ? [zone] : hits;
};

function groupByColumn(cards: Cards, override: Record<string, ReviewColumn> = {}) {
  const byColumn: Record<ReviewColumn, Cards> = {
    todo: [],
    processing: [],
    done: [],
    dropped: [],
  };
  for (const card of cards) byColumn[override[card.path] ?? card.column].push(card);
  for (const col of REVIEW_COLUMNS) {
    byColumn[col].sort(
      (a, b) =>
        (b.date ?? "").localeCompare(a.date ?? "") ||
        (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity),
    );
  }
  return byColumn;
}

export function KanbanBoard({
  cards,
  owner,
  repo,
  runningPaths = EMPTY,
}: {
  cards: Cards;
  owner: string;
  repo: string;
  /** Card paths with a live agent — surfaced as a "running" badge + drag lock. */
  runningPaths?: Set<string>;
}) {
  // Drag-and-drop + status persistence is local-only — the hosted board is
  // read-only, so it renders the static, non-draggable board.
  if (__LANEWORK_LOCAL__)
    return <LocalBoard cards={cards} owner={owner} repo={repo} runningPaths={runningPaths} />;
  return <StaticBoard cards={cards} />;
}

/** Read-only board (hosted): group into columns, render each column. */
function StaticBoard({ cards }: { cards: Cards }) {
  const columns = useMemo(() => groupByColumn(cards), [cards]);
  return (
    <div className="flex h-full gap-4 overflow-x-auto px-6 pb-6 pt-1">
      {REVIEW_COLUMNS.map((col, i) => (
        <KanbanColumn key={col} meta={STATUS_META[col]} cards={columns[col]} index={i} />
      ))}
    </div>
  );
}

/**
 * Local board: drag a card between columns to change its status (persisted to the
 * frontmatter on disk). An agent is dispatched via the card's Run button, not by a
 * column — a card with a live agent shows a "running" badge and is locked from drag.
 */
function LocalBoard({
  cards,
  owner,
  repo,
  runningPaths,
}: {
  cards: Cards;
  owner: string;
  repo: string;
  runningPaths: Set<string>;
}) {
  // Optimistic moves: show the card in its new column immediately, then let the
  // file-watcher's loader refresh confirm it. Cleared whenever fresh data arrives.
  const [pending, setPending] = useState<Record<string, ReviewColumn>>({});
  const [activeCard, setActiveCard] = useState<ReviewCard | null>(null);

  const dataKey = cards.map((c) => `${c.path}:${c.column}`).join("|");
  useEffect(() => setPending({}), [dataKey]);

  const columns = useMemo(() => groupByColumn(cards, pending), [cards, pending]);

  // A small drag threshold so a plain click still opens the card dialog.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => {
    setActiveCard((e.active.data.current?.card as ReviewCard) ?? null);
  };

  const moveCard = async (card: ReviewCard, to: ReviewColumn) => {
    if (to === card.column) return;
    setPending((p) => ({ ...p, [card.path]: to }));
    try {
      await setCardStatus({ data: { owner, repo, path: card.path, status: to } });
    } catch (err) {
      setPending((p) => {
        const next = { ...p };
        delete next[card.path];
        return next;
      });
      const msg = err instanceof Error ? err.message : String(err);
      if (typeof window !== "undefined") window.alert(`Couldn't move card: ${msg}`);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveCard(null);
    const card = e.active.data.current?.card as ReviewCard | undefined;
    const overId = e.over?.id as string | undefined;
    if (!card || !overId) return;
    // The top/bottom screen zones are shortcuts to Done / Archived; otherwise the
    // target is the column the card was dropped on.
    const to: ReviewColumn | undefined =
      overId === ZONE_DONE
        ? "done"
        : overId === ZONE_ARCHIVE
          ? "dropped"
          : (REVIEW_COLUMNS as readonly string[]).includes(overId)
            ? (overId as ReviewColumn)
            : undefined;
    if (to) moveCard(card, to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto px-6 pb-6 pt-1">
        {REVIEW_COLUMNS.map((col, i) => (
          <DroppableColumn key={col} column={col} cards={columns[col]} index={i} runningPaths={runningPaths} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="w-[19rem] rotate-2 opacity-90">
            <KanbanCard card={activeCard} />
          </div>
        ) : null}
      </DragOverlay>
      {/* Edge drop zones — only while dragging: top → Done, bottom → Archived. */}
      {activeCard ? (
        <>
          <DropZone id={ZONE_DONE} edge="top" label="Move to Done" icon={CheckmarkCircle02Icon} tone="done" />
          <DropZone id={ZONE_ARCHIVE} edge="bottom" label="Archive" icon={Archive02Icon} tone="archive" />
        </>
      ) : null}
    </DndContext>
  );
}

/** One column, droppable; highlights while a card hovers over it. */
function DroppableColumn({
  column,
  cards,
  index,
  runningPaths,
}: {
  column: ReviewColumn;
  cards: Cards;
  index: number;
  runningPaths: Set<string>;
}) {
  const meta = STATUS_META[column];
  const { setNodeRef, isOver } = useDroppable({ id: column });
  return (
    <motion.div
      ref={setNodeRef}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "flex h-full w-80 shrink-0 flex-col rounded-2xl bg-muted/40 ring-2 ring-transparent transition-colors",
        isOver && "bg-muted/70 ring-ring/30",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <HugeiconsIcon icon={meta.icon} className={cn("size-4", meta.color)} />
        <h2 className="text-sm font-medium text-foreground">{meta.label}</h2>
        <span className="text-sm text-muted-foreground">{cards.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5 pt-0.5">
        {cards.length === 0 ? (
          <p className="rounded-xl border border-dashed py-8 text-center text-xs text-muted-foreground">
            No reviews
          </p>
        ) : (
          cards.map((card) => (
            <DraggableCard key={card.path} card={card} running={runningPaths.has(card.path)} />
          ))
        )}
      </div>
    </motion.div>
  );
}

/** A full-width drop zone pinned to the top or bottom of the viewport, shown only
 *  while a card is being dragged. Highlights when the card hovers over it. */
function DropZone({
  id,
  edge,
  label,
  icon,
  tone,
}: {
  id: string;
  edge: "top" | "bottom";
  label: string;
  icon: typeof Archive02Icon;
  tone: "done" | "archive";
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "fixed inset-x-0 z-50 flex h-12 items-center justify-center gap-2 text-sm font-medium backdrop-blur-sm transition-colors",
        edge === "top" ? "top-0" : "bottom-0",
        tone === "done"
          ? isOver
            ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            : "bg-emerald-500/[0.06] text-emerald-600/80"
          : isOver
            ? "bg-zinc-500/20 text-foreground"
            : "bg-muted/50 text-muted-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} className="size-5" />
      {label}
    </div>
  );
}

/** A draggable card. The drag listeners coexist with the card's click-to-open via
 *  the PointerSensor distance threshold above. A card with a live agent is **locked**
 *  (not draggable) so a stray drag can't interrupt it — stop it from the card dialog. */
function DraggableCard({ card, running }: { card: ReviewCard; running: boolean }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: card.path,
    data: { card },
    disabled: running,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title={running ? "An agent is working — open the card and Stop it to move this." : undefined}
      className={cn(isDragging && "opacity-40")}
    >
      <KanbanCard card={card} running={running} />
    </div>
  );
}
