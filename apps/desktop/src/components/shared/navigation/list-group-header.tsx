import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

/**
 * A list group's header: its name and count, a toggle that folds it. The
 * issue list's lanes and the pull request list's groups share it, so the
 * two lists read alike.
 */
export function ListGroupHeader({
  name,
  count,
  open,
  onToggle,
  icon,
}: {
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="text-muted-foreground hover:text-foreground flex h-7 w-full items-center gap-1.5 rounded-md px-3 text-[11px] font-medium tracking-wide uppercase transition-colors"
    >
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        strokeWidth={2}
        aria-hidden="true"
      />
      {icon}
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground/70 font-normal tabular-nums">
        {count}
      </span>
    </button>
  );
}
