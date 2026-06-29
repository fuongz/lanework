import {
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
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { REVIEW_COLUMNS, type ReviewCard, type ReviewColumn } from "@/lib/github";
import { STATUS_META } from "@/lib/review-status";
import { cn } from "@/lib/utils";
import type { BoardData } from "@/server/reviews";
import { setCardStatus } from "@/server/reviews";
import { CreateCardDialog } from "./create-card-dialog";
import { KanbanCard } from "./kanban-card";
import { KanbanColumn } from "./kanban-column";

type Cards = BoardData["cards"];
const EMPTY = new Set<string>();

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
  const [addOpen, setAddOpen] = useState(false);

  const dataKey = cards.map((c) => `${c.path}:${c.column}`).join("|");
  useEffect(() => setPending({}), [dataKey]);

  const columns = useMemo(() => groupByColumn(cards, pending), [cards, pending]);

  // A small drag threshold so a plain click still opens the card dialog.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => {
    setActiveCard((e.active.data.current?.card as ReviewCard) ?? null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveCard(null);
    const card = e.active.data.current?.card as ReviewCard | undefined;
    const to = e.over?.id as ReviewColumn | undefined;
    if (!card || !to || !REVIEW_COLUMNS.includes(to)) return;
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto px-6 pb-6 pt-1">
        {REVIEW_COLUMNS.map((col, i) => (
          <DroppableColumn
            key={col}
            column={col}
            cards={columns[col]}
            index={i}
            runningPaths={runningPaths}
            onAdd={col === "todo" ? () => setAddOpen(true) : undefined}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="w-[19rem] rotate-2 opacity-90">
            <KanbanCard card={activeCard} />
          </div>
        ) : null}
      </DragOverlay>
      <CreateCardDialog open={addOpen} onOpenChange={setAddOpen} owner={owner} repo={repo} />
    </DndContext>
  );
}

/** One column, droppable; highlights while a card hovers over it. */
function DroppableColumn({
  column,
  cards,
  index,
  runningPaths,
  onAdd,
}: {
  column: ReviewColumn;
  cards: Cards;
  index: number;
  runningPaths: Set<string>;
  onAdd?: () => void;
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
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            title="Add a task"
            aria-label="Add a task"
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
          >
            <HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
            Add
          </button>
        ) : null}
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
