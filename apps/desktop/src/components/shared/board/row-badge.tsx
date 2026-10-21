import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * A small pill on the first line of an issue-list row: where it stands, and
 * its id (FE-75).
 *
 * NOTE: Pills rather than a sentence with separators. Two facts set side by
 * side read as two, without a "·" between them to say so.
 *
 * NOTE: Filled with the page colour and outlined, not tinted. The list sits on
 * the sidebar's grey, and a selected or hovered row is a shade darker again;
 * a tint of the same grey disappeared into both.
 */
export function RowBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "bg-background text-muted-foreground border-foreground/10 inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] whitespace-nowrap shadow-[0_1px_0_0_rgb(0_0_0/0.02)] dark:bg-foreground/[0.08] dark:border-foreground/10",
        className,
      )}
    >
      {children}
    </span>
  );
}
