import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  CheckmarkSquare02Icon,
  Comment01Icon,
  Flag02Icon,
  Coins01Icon,
} from "@hugeicons/core-free-icons";
import type { ReviewCard, Priority, LastRun } from "@/lib/github";
import { useBoardStore } from "@/stores/board-store";
import { RunAgentButton, AgentWorkingBadge } from "./run-agent-button";
import { AssigneeAvatar } from "./assignee-avatar";
import { progressPercent } from "@/lib/review-stats";
import { formatDate } from "@/lib/format";
import { tagPill } from "@/lib/tag-color";
import { formatRunCost, runResultClass } from "@/lib/run-format";
import { cn } from "@/lib/utils";

const PRIORITY_ICON: Record<Priority, string> = {
  high: "text-rose-500 fill-rose-100",
  medium: "text-amber-500 fill-amber-100",
  low: "text-muted-foreground/50 fill-muted-foreground",
};

export function KanbanCard({ card, running = false }: { card: ReviewCard; running?: boolean }) {
  const openCard = useBoardStore((s) => s.openCard);
  const pct = progressPercent(card.stats);
  const hasFooter =
    card.stats.notes > 0 ||
    card.stats.total > 0 ||
    card.tags.length > 0 ||
    card.assignees.length > 0 ||
    card.lastRun != null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Ignore clicks that bubbled (through a React portal) from the Run-options
        // popover / its selects — their DOM lives in <body>, not inside this card.
        if (!e.currentTarget.contains(e.target as Node)) return;
        openCard(card);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // key events from nested controls
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCard(card);
        }
      }}
      className="group relative cursor-pointer rounded-xl border border-border bg-card p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-shadow duration-200 hover:shadow-[0_3px_10px_rgba(0,0,0,0.10)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {/* Quick "Run agent" — explicit alternative; local only, hidden while running. */}
      {__LANEWORK_LOCAL__ && !running ? (
        <RunAgentButton
          path={card.path}
          className="absolute right-2.5 top-2.5 z-10 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        />
      ) : null}

      {/* Title + priority indicator */}
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 flex-1 text-sm font-semibold leading-snug text-card-foreground">
          {card.title}
        </h3>
        {card.priority ? (
          <span title={`${card.priority} priority`} className="mt-0.5 shrink-0 group-hover:opacity-0">
            <HugeiconsIcon icon={Flag02Icon} className={cn("size-4", PRIORITY_ICON[card.priority])} />
          </span>
        ) : null}
      </div>

      {/* Description preview */}
      {card.summary ? (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{card.summary}</p>
      ) : null}

      {running ? <AgentWorkingBadge className="mt-2.5" /> : null}

      {/* Date */}
      {card.date ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <HugeiconsIcon icon={Calendar03Icon} className="size-3.5" />
          <span className="tabular-nums">{formatDate(card.date)}</span>
        </div>
      ) : null}

      {/* Footer: counts + labels + assignees, above a hairline divider */}
      {hasFooter ? (
        <div className="mt-3 flex items-center gap-2.5 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
          {card.stats.notes > 0 ? (
            <span className="inline-flex items-center gap-1" title="Reviewer notes">
              <HugeiconsIcon icon={Comment01Icon} className="size-3.5" />
              {card.stats.notes}
            </span>
          ) : null}

          {card.stats.total > 0 ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 tabular-nums",
                pct === 100 && "font-medium text-emerald-600 dark:text-emerald-400",
              )}
              title="Checklist items done"
            >
              <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3.5" />
              {card.stats.done}/{card.stats.total}
            </span>
          ) : null}

          {card.lastRun ? <LastRunCost run={card.lastRun} /> : null}

          {card.tags.length > 0 ? <Labels tags={card.tags} /> : null}

          {card.assignees.length > 0 ? (
            <div className="ml-auto">
              <Assignees logins={card.assignees} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Estimated cost of the card's most recent agent run, colored by result. */
function LastRunCost({ run }: { run: LastRun }) {
  const detail = [
    run.result ?? "run",
    run.runtime,
    `${run.tokensIn + run.cache} in`,
    `${run.tokensOut} out`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={`Last agent run — ${detail}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        runResultClass(run.result),
      )}
    >
      <HugeiconsIcon icon={Coins01Icon} className="size-3" />
      {formatRunCost(run.costUsd)}
    </span>
  );
}

/** Up to two colored label pills + a "+N" overflow. */
function Labels({ tags }: { tags: string[] }) {
  const shown = tags.slice(0, 2);
  const extra = tags.length - shown.length;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          title={tag}
          className={cn("max-w-[6rem] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium", tagPill(tag))}
        >
          {tag}
        </span>
      ))}
      {extra > 0 ? <span className="text-[11px] text-muted-foreground">+{extra}</span> : null}
    </span>
  );
}

/** Stacked, overlapping assignee avatars (Todoist-style). */
function Assignees({ logins }: { logins: string[] }) {
  const shown = logins.slice(0, 3);
  const extra = logins.length - shown.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {shown.map((login) => (
          <AssigneeAvatar key={login} login={login} className="size-5 ring-2 ring-card" />
        ))}
      </div>
      {extra > 0 ? <span className="ml-1 text-[11px] text-muted-foreground">+{extra}</span> : null}
    </div>
  );
}
