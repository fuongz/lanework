import { HugeiconsIcon } from "@hugeicons/react";
import { Flag02Icon, CheckmarkSquare02Icon, Comment01Icon } from "@hugeicons/core-free-icons";
import type { ReviewCard, Priority } from "@/lib/github";
import { useBoardStore } from "@/stores/board-store";
import { progressPercent } from "@/lib/review-stats";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function KanbanCard({ card }: { card: ReviewCard }) {
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
      className="group cursor-pointer rounded-xl border bg-card p-3.5 shadow-xs transition-shadow duration-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <h3 className="line-clamp-2 text-sm font-medium leading-snug text-card-foreground">
        {card.title}
      </h3>

      {card.assignees.length > 0 ? (
        <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Assignees:</span>
          <Assignees logins={card.assignees} />
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Flag02Icon} className="size-3.5" />
        <span>{formatDate(card.date)}</span>
        {card.priority ? <PriorityBadge priority={card.priority} /> : null}
      </div>

      <div className="mt-3 flex items-center gap-3 border-t pt-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1" title="Checklist items done">
          <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3.5" />
          {card.stats.done}/{card.stats.total}
        </span>
        <span className="inline-flex items-center gap-1" title="Reviewer notes">
          <HugeiconsIcon icon={Comment01Icon} className="size-3.5" />
          {card.stats.notes}
        </span>
        {pct !== null ? (
          <span
            className={cn(
              "ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium",
              pct === 100
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : pct === 0
                  ? "bg-muted text-muted-foreground"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
            )}
          >
            {pct}%
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Assignees({ logins }: { logins: string[] }) {
  const shown = logins.slice(0, 3);
  const extra = logins.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {shown.map((login) => (
          <img
            key={login}
            src={`https://github.com/${login}.png?size=40`}
            alt={login}
            title={login}
            className="size-5 rounded-full ring-2 ring-card"
          />
        ))}
      </div>
      {extra > 0 ? <span className="ml-1 text-[11px]">{extra}+</span> : null}
    </div>
  );
}

const PRIORITY_STYLE: Record<Priority, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={cn(
        "ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize",
        PRIORITY_STYLE[priority],
      )}
    >
      {priority}
    </span>
  );
}
