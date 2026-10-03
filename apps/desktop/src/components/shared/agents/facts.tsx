import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * One fact in a header's second row: what it is, said by its icon — a
 * sub-agent's (FE-35) or a conversation's (FE-38). A plain record, so a
 * caller appends whatever facts it has to the list.
 */
export interface Fact {
  key: string;
  /** What it is, for a screen reader and the tooltip. */
  label: string;
  icon?: IconSvgElement;
  /** A mark of its own in the icon's place: the working dot. */
  mark?: ReactNode;
  text: string;
  /** The tooltip, when it says more than the label (the model's own id). */
  title?: string;
  className?: string;
}

/**
 * The header's second row: each fact by its own icon, no separators.
 *
 * ⚠️ ABOVE the scroller, not sticky inside it, for the issue page's reason:
 * a sticky row is laid out in the scroller's content box, which stops at
 * the scrollbar gutter — its `border-b` ended short of the pane's edge. Out
 * here it is always in view and its line runs the full width. A `<dl>`, so
 * each fact is read with what it is.
 */
export function Facts({
  facts,
  inline = false,
  className,
  "data-testid": testId,
}: {
  facts: Fact[];
  /**
   * Inside a header's own row rather than a row of its own: no rule under
   * it, no wrapping — what does not fit is cut, the tooltips keep it all.
   */
  inline?: boolean;
  /** Its side padding, lined up with the header above it. */
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <dl
      data-testid={testId}
      className={cn(
        "text-muted-foreground flex items-center text-xs",
        inline
          ? "min-w-0 gap-x-3 overflow-hidden"
          : "border-sidebar-border shrink-0 flex-wrap gap-x-4 gap-y-1 border-b px-6 py-2",
        className,
      )}
    >
      {facts.map((fact) => (
        <div
          key={fact.key}
          title={fact.title ?? fact.label}
          className={cn("flex min-w-0 items-center gap-1.5", fact.className)}
        >
          <dt className="sr-only">{fact.label}</dt>
          {fact.icon ? (
            <HugeiconsIcon
              icon={fact.icon}
              className="size-3.5 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : (
            fact.mark
          )}
          <dd className="truncate">{fact.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `claude-haiku-4-5-20251001` → `Haiku 4.5`; any other model as named. */
export function modelLabel(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  if (!claude?.[1]) return model;
  return `${claude[1][0]?.toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
}

/** A length of time as a person reads it: `68s`, `4m 12s`, `1h 3m`. */
export function durationText(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A token count, short: `980`, `14.2k`, `142k`, `1.4M`. */
export function tokenText(count: number): string {
  const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 99_950) return `${short(count / 1000)}k`;
  if (count < 999_500) return `${Math.round(count / 1000)}k`;
  return `${short(count / 1_000_000)}M`;
}

/**
 * An estimate in dollars, as one: `≈ $0.73` — and under a cent, said so
 * rather than `≈ $0.00`.
 */
export function costText(usd: number): string {
  if (usd < 0.01) return "< $0.01";
  return `≈ $${usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
