import { ArrowDown01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * One task of a proposal or a run, drawn the same in both (the proposal
 * card's tasks become the run's workers): change it here and both follow.
 *
 * `[mark] [title] [badge] ··· [trailing] [chevron]`, one line. The row lifts
 * on hover and stays lifted while open; its body opens under it, lined up
 * with the title. A thread runs from the mark down to the next row's mark:
 * solid green once this task is done, a grey dash while it is still to come.
 */
export function TaskRow({
  id,
  mark,
  title,
  tip,
  badge,
  trailing,
  actions,
  expandable = true,
  open,
  onToggle,
  label,
  last,
  done,
  below,
  children,
}: {
  /** The row's DOM id; the toggle is its first button. */
  id: string;
  /** A 16px mark, the title's size: the run's status, or the proposal's number. */
  mark: ReactNode;
  title: string;
  /** The title's tooltip: the whole title and its task id. */
  tip: string;
  badge?: ReactNode;
  /** Right of the title: the model pill, the time. */
  trailing?: ReactNode;
  /** Shown while the row is hovered or holds the focus: Open chat. */
  actions?: ReactNode;
  /** It has a body to open. Without one: no chevron, and it never opens. */
  expandable?: boolean;
  open: boolean;
  onToggle: () => void;
  /** The toggle's accessible name. */
  label: string;
  /** Its step's last row: no thread down from its mark. */
  last: boolean;
  /** Done: the thread under it is solid. */
  done: boolean;
  /** Between the row and its body, open or not (a warning). */
  below?: ReactNode;
  /** The body, drawn while open. */
  children?: ReactNode;
}) {
  return (
    <li id={id} className="relative">
      {!last && (
        // From under this mark to the next row's: the row is 40px tall and
        // its 16px mark sits 12px from its top, 8px + 8px from its left.
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-[30px] -bottom-[10px] left-[15px] border-l-2",
            done
              ? "border-tone-emerald/35"
              : "border-foreground/15 border-dashed",
          )}
        />
      )}
      <div
        className={cn(
          "group/row flex min-h-10 min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-150",
          open ? "bg-muted/70" : "hover:bg-muted/50",
        )}
      >
        <button
          type="button"
          aria-expanded={expandable ? open : undefined}
          aria-label={label}
          disabled={!expandable}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none disabled:cursor-default"
        >
          <span className="flex shrink-0">{mark}</span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="text-foreground min-w-0 truncate text-[13px] leading-snug font-normal"
              title={tip}
            >
              {title}
            </span>
            {badge}
          </span>
        </button>
        {actions && (
          // Opacity only, so it fades in without moving the row; it still
          // takes its place, so nothing shifts when it shows.
          <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none">
            {actions}
          </span>
        )}
        {trailing}
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={onToggle}
            className="text-muted-foreground/70 hover:text-foreground grid size-5 shrink-0 place-items-center"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(
                "size-3 transition-transform duration-150",
                open && "rotate-180",
              )}
            />
          </button>
        ) : (
          // Its place kept, so the times and pills above and below line up.
          <span aria-hidden="true" className="size-5 shrink-0" />
        )}
      </div>
      {below}
      {open && expandable && (
        // Lined up with the title: the row's padding, the mark, the gap.
        <div className="mt-2 mr-2 mb-3 ml-9 flex min-w-0 flex-col gap-2.5 text-[12px]">
          {children}
        </div>
      )}
    </li>
  );
}

/** A small tinted pill beside a task's title: its status, or a fact. */
export function TaskBadge({
  tone,
  icon,
  children,
}: {
  /** A text colour class; the pill's fill and border take it too. */
  tone: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full border border-current/25 bg-current/10 px-2 text-[10.5px] font-semibold tracking-[0.05em] uppercase",
        tone,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * The status of a whole proposal or run, at its card's top right: a tinted
 * pill with a dot, in small caps, as a task's badge but a size up.
 */
export function StatusPill({
  tone,
  live = false,
  children,
}: {
  /** A text colour class; the pill's fill, border and dot take it too. */
  tone: string;
  /** Still moving: the dot pulses. */
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-current/20 bg-current/10 px-2.5 text-[11px] font-semibold tracking-[0.06em] uppercase",
        tone,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          live && "animate-pulse motion-reduce:animate-none",
        )}
      />
      {children}
    </span>
  );
}

/** A task that may change no file: the same badge on a proposal and a run. */
export function ReadOnlyBadge() {
  // Grey: a fact about the task, not a status, so it takes no tone. A
  // padlock: it may read but not write.
  return (
    <TaskBadge
      tone="text-muted-foreground"
      icon={
        <HugeiconsIcon
          icon={SquareLock02Icon}
          className="size-3"
          strokeWidth={2.2}
          aria-hidden="true"
        />
      }
    >
      Read only
    </TaskBadge>
  );
}
