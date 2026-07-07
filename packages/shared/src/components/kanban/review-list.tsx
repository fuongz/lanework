import { useMemo } from "react";
import { motion, type Variants } from "motion/react";
import type { BoardData } from "@/server/reviews";
import { REVIEW_COLUMNS, type ReviewColumn, type ReviewCard, type Priority } from "@/lib/github";
import { useBoardStore } from "@/stores/board-store";
import { RunAgentButton, AgentWorkingBadge } from "./run-agent-button";
import { AssigneeAvatar } from "./assignee-avatar";
import { progressPercent } from "@/lib/review-stats";
import { statusMeta } from "@/lib/review-status";
import { formatDate } from "@/lib/format";
import { tagPill } from "@/lib/tag-color";
import { cn } from "@/lib/utils";

// One grid template shared by the column header and every row so columns line
// up. Cells collapse responsively: Name + Assignees always show; Priority and
// Progress join at md; Tags and Date at lg.
const GRID =
  "grid items-center gap-x-4 px-4 " +
  "grid-cols-[minmax(0,1fr)_auto] " +
  "md:grid-cols-[minmax(0,1fr)_104px_72px_auto] " +
  "lg:grid-cols-[minmax(0,1fr)_104px_minmax(0,1fr)_140px_72px_auto]";

const HEADER_TINT: Record<ReviewColumn, string> = {
  todo: "bg-muted/70",
  processing: "bg-blue-50 dark:bg-blue-950/30",
  done: "bg-emerald-50 dark:bg-emerald-950/30",
  dropped: "bg-rose-50 dark:bg-rose-950/30",
};

const DOT: Record<ReviewColumn, string> = {
  todo: "bg-amber-500",
  processing: "bg-blue-500",
  done: "bg-emerald-500",
  dropped: "bg-rose-500",
};

const STAGGER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};
const ROW_ITEM: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" } },
};

const EMPTY = new Set<string>();

export function ReviewList({
  cards,
  runningPaths = EMPTY,
  statusLabels,
}: {
  cards: BoardData["cards"];
  runningPaths?: Set<string>;
  /** Column display label overrides from `.agents/reviews/config.json`. */
  statusLabels?: Partial<Record<ReviewColumn, string>>;
}) {
  const grouped = useMemo(() => {
    const by: Record<ReviewColumn, ReviewCard[]> = { todo: [], processing: [], done: [], dropped: [] };
    for (const c of cards) by[c.column].push(c);
    for (const col of REVIEW_COLUMNS)
      by[col].sort(
        (a, b) =>
          (b.date ?? "").localeCompare(a.date ?? "") ||
          (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity),
      );
    return by;
  }, [cards]);

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <div className="flex flex-col gap-7">
        {REVIEW_COLUMNS.map((col, ci) =>
          grouped[col].length === 0 ? null : (
            <motion.section
              key={col}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: Math.min(ci, 4) * 0.06, ease: [0.22, 1, 0.36, 1] }}
            >
              {/* Status header bar */}
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2",
                  HEADER_TINT[col],
                )}
              >
                <span className={cn("size-2.5 rounded-full", DOT[col])} />
                <h2 className="text-sm font-semibold">{statusMeta(col, statusLabels).label}</h2>
                <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                  {String(grouped[col].length).padStart(2, "0")}
                </span>
              </div>

              {/* Column headers */}
              <div className={cn(GRID, "border-b py-2 text-xs font-medium text-muted-foreground")}>
                <span>Name</span>
                <span className="hidden md:block">Priority</span>
                <span className="hidden lg:block">Tags</span>
                <span className="hidden lg:block">Date</span>
                <span className="hidden md:block">Progress</span>
                <span className="text-right">Assignees</span>
              </div>

              <motion.div variants={STAGGER} initial="hidden" animate="show">
                {grouped[col].map((card) => (
                  <ListRow key={card.path} card={card} running={runningPaths.has(card.path)} />
                ))}
              </motion.div>
            </motion.section>
          ),
        )}
      </div>
    </div>
  );
}

function ListRow({ card, running }: { card: ReviewCard; running: boolean }) {
  const openCard = useBoardStore((s) => s.openCard);
  const pct = progressPercent(card.stats);

  return (
    <motion.div
      variants={ROW_ITEM}
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
        GRID,
        "group cursor-pointer border-b py-2.5 text-sm transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{card.title}</span>
        {__LANEWORK_LOCAL__ && running ? <AgentWorkingBadge className="shrink-0" /> : null}
        {__LANEWORK_LOCAL__ && !running ? (
          <RunAgentButton
            path={card.path}
            className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          />
        ) : null}
      </span>

      <span className="hidden md:block">
        <PriorityPill priority={card.priority} />
      </span>

      <span className="hidden min-w-0 items-center gap-1 lg:flex">
        <Tags tags={card.tags} />
      </span>

      <span className="hidden text-xs text-muted-foreground tabular-nums lg:block">
        {card.date ? formatDate(card.date) : "—"}
      </span>

      <span
        className={cn(
          "hidden text-xs tabular-nums md:block",
          pct === 100 ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
        )}
      >
        {card.stats.total > 0 ? `${card.stats.done}/${card.stats.total}` : "—"}
      </span>

      <Assignees logins={card.assignees} />
    </motion.div>
  );
}

const PRIORITY: Record<Priority, { label: string; className: string }> = {
  high: { label: "High", className: "border-rose-300 text-rose-600 dark:border-rose-900 dark:text-rose-400" },
  medium: { label: "Normal", className: "border-blue-300 text-blue-600 dark:border-blue-900 dark:text-blue-400" },
  low: { label: "Low", className: "border-emerald-300 text-emerald-600 dark:border-emerald-900 dark:text-emerald-400" },
};

function PriorityPill({ priority }: { priority: Priority | null }) {
  if (!priority) {
    return (
      <span className="inline-flex rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Not set
      </span>
    );
  }
  const p = PRIORITY[priority];
  return (
    <span className={cn("inline-flex rounded-md border bg-background px-2 py-0.5 text-xs font-medium", p.className)}>
      {p.label}
    </span>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const shown = tags.slice(0, 2);
  const extra = tags.length - shown.length;
  return (
    <>
      {shown.map((tag) => (
        <span
          key={tag}
          title={tag}
          className={cn("max-w-[8rem] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium", tagPill(tag))}
        >
          {tag}
        </span>
      ))}
      {extra > 0 ? <span className="text-[11px] text-muted-foreground">+{extra}</span> : null}
    </>
  );
}

function Assignees({ logins }: { logins: string[] }) {
  if (logins.length === 0) {
    return <span className="text-right text-xs text-muted-foreground">—</span>;
  }
  const shown = logins.slice(0, 4);
  const extra = logins.length - shown.length;
  return (
    <div className="flex items-center justify-end">
      <div className="flex -space-x-1.5">
        {shown.map((login) => (
          <AssigneeAvatar key={login} login={login} className="size-5 ring-2 ring-background" />
        ))}
      </div>
      {extra > 0 ? <span className="ml-1 text-[11px] text-muted-foreground">+{extra}</span> : null}
    </div>
  );
}
