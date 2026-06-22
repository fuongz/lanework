import { useMemo } from "react";
import type { BoardData } from "@/server/reviews";
import { REVIEW_COLUMNS, type ReviewColumn } from "@/lib/github";
import { STATUS_META } from "@/lib/review-status";
import { KanbanColumn } from "./kanban-column";

export function KanbanBoard({ cards }: { cards: BoardData["cards"] }) {
  const columns = useMemo(() => {
    const byColumn: Record<ReviewColumn, BoardData["cards"]> = {
      todo: [],
      processing: [],
      done: [],
      dropped: [],
    };
    for (const card of cards) byColumn[card.column].push(card);
    for (const col of REVIEW_COLUMNS) {
      byColumn[col].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    }
    return byColumn;
  }, [cards]);

  return (
    <div className="flex h-full gap-4 overflow-x-auto px-6 pb-6">
      {REVIEW_COLUMNS.map((col, i) => (
        <KanbanColumn key={col} meta={STATUS_META[col]} cards={columns[col]} index={i} />
      ))}
    </div>
  );
}
