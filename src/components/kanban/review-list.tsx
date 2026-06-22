import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Flag02Icon } from "@hugeicons/core-free-icons";
import type { BoardData } from "@/server/reviews";
import { REVIEW_COLUMNS, type ReviewColumn, type ReviewCard } from "@/lib/github";
import { useBoardStore } from "@/stores/board-store";
import { progressPercent } from "@/lib/review-stats";
import { STATUS_META } from "@/lib/review-status";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ReviewList({ cards }: { cards: BoardData["cards"] }) {
  const grouped = useMemo(() => {
    const by: Record<ReviewColumn, ReviewCard[]> = { todo: [], processing: [], done: [], dropped: [] };
    for (const c of cards) by[c.column].push(c);
    for (const col of REVIEW_COLUMNS) by[col].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return by;
  }, [cards]);

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <div className="flex flex-col gap-6">
        {REVIEW_COLUMNS.map((col) =>
          grouped[col].length === 0 ? null : (
            <section key={col}>
              <div className="mb-2 flex items-center gap-2">
                <HugeiconsIcon icon={STATUS_META[col].icon} className={cn("size-4", STATUS_META[col].color)} />
                <h2 className="text-sm font-medium">{STATUS_META[col].label}</h2>
                <span className="text-sm text-muted-foreground">{grouped[col].length}</span>
              </div>
              <div className="overflow-hidden rounded-xl border">
                {grouped[col].map((card, i) => (
                  <ListRow key={card.path} card={card} first={i === 0} />
                ))}
              </div>
            </section>
          ),
        )}
      </div>
    </div>
  );
}

function ListRow({ card, first }: { card: ReviewCard; first: boolean }) {
  const openCard = useBoardStore((s) => s.openCard);
  const pct = progressPercent(card.stats);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openCard(card)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCard(card);
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-4 px-4 py-2.5 text-sm transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
        !first && "border-t",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        <HugeiconsIcon icon={Flag02Icon} className="size-3.5" />
        {formatDate(card.date)}
      </span>
      <span className="w-16 text-right text-xs text-muted-foreground">
        {card.stats.done}/{card.stats.total}
      </span>
      <span className="w-12 text-right text-xs text-muted-foreground">{pct !== null ? `${pct}%` : ""}</span>
    </div>
  );
}
