import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { motion } from "motion/react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  BoardCard,
  BoardCategory,
  BoardColumn,
} from "#/../shared/workspaces";
import {
  CategoryDot,
  ChecklistProgress,
  Fraction,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { IssueMenu } from "#/components/shared/board/issue-menu";
import { LoadMore } from "#/components/shared/board/load-more";
import { BoardLanesSkeleton } from "#/components/shared/board/skeletons";
import { Empty, EmptyDescription, EmptyHeader } from "#/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "#/components/ui/select";
import {
  byRank,
  categoryOf,
  columnOf,
  filterCards,
  shortAge,
} from "#/lib/board-view";
import { useBoard } from "#/stores/board";

/** Where a dragged card would land: beside which card, on which side. */
interface DropTarget {
  columnKey: string;
  cardId: string | null;
  before: boolean;
}

/** `2/5` per parent card, or nothing for a card with no children. */
type Progress = Map<string, { done: number; total: number }>;

/**
 * Two kinds of drop target, told apart by their id.
 *
 * ⚠️ A card is BOTH a draggable and a droppable, under the same id. That is
 * what buys placement: dropping on the top half of a card means "above this
 * one", which a lane-shaped target could never express — it can only ever mean
 * "somewhere in this lane". The lane is still a target, for the empty ones and
 * for the space under the last card, where "append" is exactly right.
 */
const cardTarget = (cardId: string) => `card:${cardId}`;
const laneTarget = (columnKey: string) => `lane:${columnKey}`;
const isCardTarget = (id: string | number) => String(id).startsWith("card:");

/**
 * A card under the pointer always wins.
 *
 * ⚠️ Not `pointerWithin` alone. Cards sit INSIDE lanes, so the pointer is
 * within both, and which one dnd-kit reports first is then a question of whose
 * centre happens to be nearer — a coin toss that decides whether a drop is
 * placed precisely or appended to the bottom of the lane. This makes the
 * precise answer the answer whenever there is one.
 */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const card = hits.find((hit) => isCardTarget(hit.id));
  return card ? [card] : hits;
};

/** The app's one ease-out curve. */
const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * What the card in hand does the instant you let go.
 *
 * ⚠️ It dissolves where you dropped it; dnd-kit's default flies it back to
 * where the drag STARTED, which on any real move is a lie — the card is not
 * going back there. The real card is already materialising in its new slot
 * (`AnimatePresence` in the lane), so this is the other half of one movement
 * rather than a rewind of it.
 *
 * `sideEffects: null` on purpose: the default fades the source card with an
 * inline style, and the source's opacity belongs to Motion below. One system
 * per property, or the two fight over the same node.
 */
const DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sideEffects: null,
  keyframes: ({ transform }) => {
    const at = `translate3d(${transform.initial.x}px, ${transform.initial.y}px, 0)`;
    return [
      { opacity: 1, transform: `${at} scale(1)` },
      { opacity: 0, transform: `${at} scale(0.94)` },
    ];
  },
};

/** How far the pointer travels before it is a drag rather than a click. */
const DRAG_PX = 6;

/**
 * Whether the board has finished its first paint (FE-15/D1).
 *
 * ⚠️ A card fades in only when it mounts AFTER that — created here, synced in
 * from elsewhere, or dropped into another lane. The lanes remount every time
 * this page is opened (coming back from a card, switching the view), and when
 * every card faded up at once the board looked like it was loading again
 * while not one request had gone out.
 */
const Settled = createContext(false);

export function BoardLanes() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues/" });
  const search = useSearch({ from: "/_app/w/$slug/issues/" });
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const move = useBoard((state) => state.move);
  // ⚠️ A boolean per card would be one subscription per card; the key itself is
  // one for the board. Exactly one card can be busy, and comparing the key in
  // the parent keeps the prop the children see a `boolean`.
  const busy = useBoard((state) => state.busy);
  /** The card in hand, kept whole — the overlay draws it, not a copy of its id. */
  const [held, setHeld] = useState<BoardCard | null>(null);
  /** The lifted card's width, so the overlay is the size of the gap it left. */
  const [heldWidth, setHeldWidth] = useState<number | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  // ⚠️ Ages are measured from when the board was READ, not from now. A row that
  // says "2h" next to a badge that says the copy is from this morning would be
  // two clocks disagreeing on the same screen.
  const now = useMemo(
    () => (view ? new Date(view.fetchedAt).getTime() : Date.now()),
    [view],
  );

  // Settled one frame after the first board is on screen, so every card of
  // that paint mounts before the flag flips.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!view || settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [view, settled]);

  // A small threshold, so a plain click still opens the card.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_PX } }),
  );

  /**
   * The lanes, bucketed once.
   *
   * ⚠️ One pass over the cards, not one FILTER PER LANE. A drag re-renders this
   * component whenever the placement changes, and re-filtering the whole board
   * once per column on each of those is work a drag cannot afford.
   */
  const lanes = useMemo(() => {
    const buckets = new Map<string, BoardCard[]>();
    for (const column of view?.columns ?? []) buckets.set(column.key, []);
    if (view)
      for (const card of filterCards(view.cards, search))
        buckets.get(card.columnKey)?.push(card);
    for (const lane of buckets.values()) lane.sort(byRank);
    return buckets;
  }, [view, search]);

  /**
   * Every parent's child tally, in one pass.
   *
   * ⚠️ This used to be `subIssueProgress(view.cards, card.id, …)` inside each
   * card — a scan of the whole board per card, so O(cards²) for every frame of
   * a drag. The numbers are identical; the cost is now linear and paid once.
   */
  const progress = useMemo<Progress>(() => {
    const totals: Progress = new Map();
    if (!view) return totals;
    const finished = new Set(
      view.columns
        .filter((column) => column.role === "done" || column.role === "archive")
        .map((column) => column.key),
    );
    for (const card of view.cards) {
      if (!card.parentId) continue;
      const entry = totals.get(card.parentId) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (finished.has(card.columnKey)) entry.done += 1;
      totals.set(card.parentId, entry);
    }
    return totals;
  }, [view]);

  /**
   * Where the card would land right now, read off the gesture.
   *
   * ⚠️ Resolved from the EVENT rather than from state, and by both the move and
   * the drop. dnd-kit reports which target the pointer is over; which half of
   * it decides whether the card goes above or below, and that needs the pointer
   * itself — hence the activator plus the delta, which is the only place
   * dnd-kit keeps a live pointer position.
   */
  const resolve = useCallback(
    (event: DragMoveEvent | DragEndEvent): DropTarget | null => {
      const over = event.over;
      if (!over) return null;
      const data = over.data.current as
        | { columnKey: string; cardId: string | null }
        | undefined;
      if (!data) return null;
      if (!isCardTarget(over.id))
        return { columnKey: data.columnKey, cardId: null, before: false };
      const start = event.activatorEvent as { clientY?: number };
      const at =
        typeof start?.clientY === "number"
          ? start.clientY + event.delta.y
          : null;
      return {
        columnKey: data.columnKey,
        cardId: data.cardId,
        before: at !== null && at < over.rect.top + over.rect.height / 2,
      };
    },
    [],
  );

  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { card?: BoardCard } | undefined;
    setHeld(data?.card ?? null);
    setHeldWidth(event.active.rect.current.initial?.width ?? null);
  };

  /**
   * ⚠️ A functional update that can return the CURRENT object, and that is the
   * point. This fires for every pointer move — dozens a second, almost all of
   * them resolving to the placement that is already on screen — and handing
   * back the same reference makes React bail out of the render entirely.
   */
  const onDragMove = (event: DragMoveEvent) => {
    const next = resolve(event);
    setTarget((current) =>
      current &&
      next &&
      current.columnKey === next.columnKey &&
      current.cardId === next.cardId &&
      current.before === next.before
        ? current
        : next,
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    const card = (event.active.data.current as { card?: BoardCard } | undefined)
      ?.card;
    setHeld(null);
    setHeldWidth(null);
    setTarget(null);
    if (!card) return;
    // ⚠️ Resolved fresh, not read from `target`. The state behind the pointer is
    // one render old by definition, and a drop is the one moment that has to
    // agree with where the card actually is.
    const at = resolve(event);
    if (!at) return;
    /**
     * ⚠️ A card cannot land relative to ITSELF. Dropping on the card you are
     * holding is the ordinary way to put one back, and naming it as the anchor
     * sent the store looking for a card it had just lifted out of the lane —
     * which fell through to "append", so putting a card back moved it to the
     * bottom of the lane and stamped a fresh `updatedAt` on it.
     */
    if (at.cardId === card.id) return;
    void move(
      card.id,
      at.columnKey,
      at.cardId
        ? at.before
          ? { before: at.cardId }
          : { after: at.cardId }
        : undefined,
    );
  };

  const onDragCancel = () => {
    setHeld(null);
    setHeldWidth(null);
    setTarget(null);
  };

  return (
    <>
      <Settled.Provider value={settled}>
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
            {!view && loading && <BoardLanesSkeleton />}
            <div className="flex h-full min-w-max gap-3 px-6 py-4">
              {(view?.columns ?? []).map((column) => (
                <Lane
                  key={column.key}
                  column={column}
                  cards={lanes.get(column.key) ?? EMPTY_CARDS}
                  // ⚠️ The SERVICE's count (FE-17): a lane holds one page of
                  // its cards, and counting those would say "20" for 226.
                  count={
                    view?.stats?.byColumn[column.key] ??
                    (lanes.get(column.key) ?? EMPTY_CARDS).length
                  }
                  slug={slug}
                  now={now}
                  columns={view?.columns ?? EMPTY_COLUMNS}
                  categories={view?.categories ?? EMPTY_CATEGORIES}
                  stale={view?.stale ?? false}
                  busy={busy}
                  held={held?.id ?? null}
                  target={target?.columnKey === column.key ? target : null}
                  progress={progress}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={DROP_ANIMATION}>
            {held ? (
              // The pickup: the card lifts off the lane with a spring rather than
              // snapping to a tilt. A touch of bounce belongs here — this is a
              // physical gesture the person is driving, not a state change.
              <motion.div
                initial={{ transform: "scale(1) rotate(0deg)" }}
                animate={{ transform: "scale(1.03) rotate(1.5deg)" }}
                transition={{ type: "spring", duration: 0.35, bounce: 0.25 }}
                style={{ width: heldWidth ?? undefined }}
                className="bg-card shadow-card cursor-grabbing rounded-lg p-2.5 shadow-2xl shadow-black/15"
              >
                <CardFace
                  card={held}
                  now={now}
                  columns={view?.columns ?? EMPTY_COLUMNS}
                  categories={view?.categories ?? EMPTY_CATEGORIES}
                  subs={progress.get(held.id) ?? null}
                />
              </motion.div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </Settled.Provider>
    </>
  );
}

/** Stable empties, so a board that has not loaded still hands `memo` one prop. */
const EMPTY_CARDS: BoardCard[] = [];
const EMPTY_COLUMNS: BoardColumn[] = [];
const EMPTY_CATEGORIES: BoardCategory[] = [];

function Lane({
  column,
  cards,
  count,
  slug,
  now,
  columns,
  categories,
  stale,
  busy,
  held,
  target,
  progress,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  /** How many cards the lane holds on the service, loaded or not. */
  count: number;
  slug: string;
  now: number;
  columns: BoardColumn[];
  categories: BoardCategory[];
  stale: boolean;
  busy: string | null;
  held: string | null;
  /** This lane's placement, or null when the card is headed somewhere else. */
  target: DropTarget | null;
  progress: Progress;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: laneTarget(column.key),
    data: { columnKey: column.key, cardId: null },
  });
  // The lane you are over says so. A line between two cards is precise but
  // invisible from the corner of the eye, and it has nothing to draw at all
  // when the lane is empty.
  const over = isOver || target !== null;
  const more = useBoard((state) =>
    Boolean(state.view?.groups?.[column.key]?.cursor),
  );

  return (
    <section
      aria-label={`${column.name} column`}
      className="flex h-full w-72 shrink-0 flex-col"
    >
      <header className="mb-2 flex h-7 shrink-0 items-center gap-2 px-1">
        <StatusIcon column={column} />
        <span className="text-[13px] font-medium">{column.name}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      </header>
      {/* ⚠️ `p-1` inside the SCROLL container, not margin outside it. A card's
          border is a 1px ring drawn as a box-shadow, and `overflow-y-auto`
          clips anything outside the padding box — so in light mode, where that
          ring is the only edge a card has, both sides of every card were shaved
          off.
          ⚠️ `relative` is REQUIRED by `mode="popLayout"` below, not decoration.
          Motion pins an exiting card with `position: absolute` against its
          `offsetParent`; with every ancestor static that is the document, so a
          card leaving this lane would escape the board's scrollers entirely for
          the length of its exit. */}
      <ul
        ref={setNodeRef}
        className={[
          "relative flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-lg p-1 pb-4 transition-colors duration-150 ease-out",
          over ? "bg-foreground/[0.03]" : "",
        ].join(" ")}
      >
        {cards.length === 0 && (
          // ⚠️ Still an `li` inside the lane's list, and still inert: an empty
          // lane is the one place a dragged card MUST be droppable, and a
          // placeholder that swallowed the drop would make exactly those lanes
          // unreachable.
          <li>
            <Empty
              className={[
                "rounded-lg border border-dashed py-6 transition-colors duration-150 ease-out",
                over ? "border-accent-brand/60" : "border-border",
              ].join(" ")}
            >
              <EmptyHeader>
                <EmptyDescription>Nothing here</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </li>
        )}
        {/* ⚠️ No `AnimatePresence`, and no exit animation on a card — read the
            note on `layout` in `LaneCard` before adding one back. The lane
            closing its gap is `layout`'s job and needs no exiting copy. */}
        {cards.map((card) => (
          <LaneCard
            key={card.id}
            card={card}
            slug={slug}
            now={now}
            columnKey={column.key}
            columns={columns}
            categories={categories}
            stale={stale}
            busy={busy === card.id}
            held={held === card.id}
            line={
              target?.cardId === card.id && held !== card.id
                ? target.before
                : undefined
            }
            subs={progress.get(card.id) ?? null}
          />
        ))}
        {more && (
          <li>
            <LoadMore
              group={column.key}
              loaded={cards.length}
              count={count}
              label={column.name}
            />
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * One card in a lane: the thing you pick up, and the place another card lands.
 *
 * ⚠️ `memo`, and every prop is a primitive or something the board owns for as
 * long as the board does. That is what makes it work: crossing one card's
 * midpoint re-renders THAT card and the one that lost the line, not the two
 * hundred that are exactly where they were.
 */
const LaneCard = memo(function LaneCard({
  card,
  slug,
  now,
  columnKey,
  columns,
  categories,
  stale,
  busy,
  held,
  line,
  subs,
}: {
  card: BoardCard;
  slug: string;
  now: number;
  columnKey: string;
  columns: BoardColumn[];
  categories: BoardCategory[];
  stale: boolean;
  busy: boolean;
  /** True while this is the card in hand — the slot it left, not the card. */
  held: boolean;
  /** True = the drop line sits above this card, false = below, undefined = none. */
  line: boolean | undefined;
  subs: { done: number; total: number } | null;
}) {
  const move = useBoard((state) => state.move);
  const settled = useContext(Settled);
  // ⚠️ A card is not draggable while the board is a saved copy. Dragging one
  // would move it on screen and then put it back, which reads as the app losing
  // the change rather than as being offline.
  const drag = useDraggable({
    id: cardTarget(card.id),
    data: { card },
    disabled: stale,
  });
  const drop = useDroppable({
    id: cardTarget(card.id),
    data: { columnKey, cardId: card.id },
  });

  const setRefs = useCallback(
    (node: HTMLLIElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    [drag.setNodeRef, drop.setNodeRef],
  );

  return (
    // ⚠️ The menu RENDERS this `li`. Wrapping it in one of its own would put a
    // div between the lane and its cards — breaking both the list semantics and
    // dnd-kit, whose droppable is measured from this element's own box.
    <IssueMenu
      card={card}
      render={
        <motion.li
          ref={setRefs}
          // ⚠️ `listeners` without dnd-kit's `attributes`. Those put
          // `role="button"` and a tabstop on the element, which would both lie
          // about an `li` in a list and hand a keyboard user a control whose
          // gesture has no keyboard equivalent. The lane Select below is that
          // equivalent, and it is real.
          {...drag.listeners}
          /**
           * ⚠️ `layout` and no `exit`. Layout is what closes the gap in this
           * lane and opens one in the destination as a card moves, so the cards
           * around the drop slide rather than jump.
           *
           * An exit animation needs `AnimatePresence`, which keeps the card
           * mounted in the lane it is LEAVING while its copy mounts in the lane
           * it is joining — for those 200ms the board holds two cards with one
           * id, two links with one accessible name, and either of them can be
           * clicked. A fade on the way out is not worth a board that is briefly
           * lying.
           */
          layout
          initial={settled ? { opacity: 0, y: 6 } : false}
          // The slot left behind: dimmed and set back a hair, so the lane reads
          // as "this place is spoken for" rather than "the card is still here".
          animate={{ opacity: held ? 0.4 : 1, y: 0, scale: held ? 0.98 : 1 }}
          transition={{ duration: 0.2, ease: EASE }}
          className={[
            "shadow-card bg-card relative touch-none rounded-lg p-2.5",
            stale ? "" : "cursor-grab active:cursor-grabbing",
            line === true
              ? "before:bg-accent-brand before:absolute before:-top-1 before:right-0 before:left-0 before:h-0.5 before:rounded-full"
              : "",
            line === false
              ? "after:bg-accent-brand after:absolute after:right-0 after:-bottom-1 after:left-0 after:h-0.5 after:rounded-full"
              : "",
          ].join(" ")}
        />
      }
    >
      <CardFace
        card={card}
        slug={slug}
        now={now}
        columns={columns}
        categories={categories}
        subs={subs}
        stale={stale}
        busy={busy}
        onMove={move}
      />
    </IssueMenu>
  );
});

/**
 * What a card looks like — drawn twice, once in the lane and once in the hand.
 *
 * ⚠️ The overlay copy gets no `slug` and no `onMove`, so it has no link and no
 * Select. A second copy of a card's controls floating under the cursor is not
 * just useless, it is two elements claiming the same accessible name.
 */
function CardFace({
  card,
  slug,
  now,
  columns,
  categories,
  subs,
  stale,
  busy,
  onMove,
}: {
  card: BoardCard;
  slug?: string;
  now: number;
  columns: BoardColumn[];
  categories: BoardCategory[];
  subs: { done: number; total: number } | null;
  stale?: boolean;
  busy?: boolean;
  onMove?: (cardId: string, columnKey: string | null) => unknown;
}) {
  const title = (
    <>
      {card.taskId && (
        <span className="text-muted-foreground font-mono text-[11px]">
          {card.taskId}
        </span>
      )}
      <p className="text-[13px] leading-snug">{card.title}</p>
    </>
  );

  return (
    <>
      {slug ? (
        <Link
          to="/w/$slug/issues/$taskId"
          params={{ slug, taskId: card.taskId ?? card.id }}
          disabled={!card.taskId}
          // ⚠️ Anchors are natively draggable, so a drag that started on the
          // title dragged the LINK — a URL payload — rather than the card.
          draggable={false}
          className="focus-visible:ring-accent-brand block rounded outline-none focus-visible:ring-2"
        >
          {title}
        </Link>
      ) : (
        <div className="block rounded">{title}</div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {/* ⚠️ A real control on the card, not a visually hidden one. Dragging
            has no keyboard equivalent, so the board needs a way to change a
            lane without a mouse — and a 1px sr-only select is a way that only
            a screen reader can find and that nobody can point at. */}
        {onMove ? (
          <Select
            value={card.columnKey}
            onValueChange={(value) => void onMove(card.id, value)}
          >
            <SelectTrigger
              size="sm"
              disabled={stale || busy}
              aria-label={`Move ${card.title} to another column`}
              className="hover:bg-foreground/[0.06] size-5 justify-center rounded border-0 bg-transparent p-0 shadow-none [&>svg:last-child]:hidden"
            >
              <StatusIcon column={columnOf(columns, card.columnKey)} />
            </SelectTrigger>
            <SelectContent>
              {columns.map((column) => (
                <SelectItem key={column.key} value={column.key}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="grid size-5 place-items-center">
            <StatusIcon column={columnOf(columns, card.columnKey)} />
          </span>
        )}
        <PriorityIcon priority={card.priority} />
        {card.categoryKey && (
          <CategoryDot category={categoryOf(categories, card.categoryKey)} />
        )}
        {subs && (
          <Fraction
            done={subs.done}
            total={subs.total}
            title={`${subs.done} of ${subs.total} sub-issues done`}
            className="text-[11px]"
          />
        )}
        {/* ⚠️ A tooltip on BOTH fractions, not just this one. Two bare `3/7`s
            side by side on a card are two different questions with the same
            face — the sub-issue one above went untitled while it was the only
            count here, and it cannot stay that way now. */}
        <ChecklistProgress card={card} className="text-[11px]" />
        <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
          {shortAge(card.updatedAt ?? card.createdAt, now)}
        </span>
      </div>
    </>
  );
}
