import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";

/**
 * The size and look of a button beside a list's search box (filter,
 * refresh): a ghost square, its icon muted until hovered.
 */
export const LIST_ACTION = "relative size-7 shrink-0";
/** The icon inside {@link LIST_ACTION}. */
export const LIST_ACTION_ICON = "text-muted-foreground size-3.5";

/**
 * A list's search row: the box, then what acts on the list beside it (a
 * filter, Refresh). One component for every list column (Issues, Pull
 * requests, Skills) so they match to the pixel.
 *
 * Escape clears the box first, and leaves it on the next press.
 */
export function ListSearch({
  query,
  onQuery,
  label,
  actions,
  className,
}: {
  query: string;
  onQuery: (next: string) => void;
  /** Its placeholder and accessible name: "Search issues". */
  label: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div className="relative min-w-0 flex-1">
        <HugeiconsIcon
          icon={Search01Icon}
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQuery("");
            }
          }}
          placeholder={label}
          aria-label={label}
          className="pl-7"
        />
      </div>
      {actions}
    </div>
  );
}
