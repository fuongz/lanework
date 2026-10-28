import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "#/components/ui/button";
import { useBoard } from "#/stores/board";

/**
 * The last row of a lane while the service has more of its cards than it
 * sent. The service pages each status on its own; given several groups, a
 * press reads the next page of each, one after another.
 */
export function LoadMore({
  groups,
  left,
}: {
  /** The groups that still have a cursor. */
  groups: string[];
  /** Cards on the service and not on screen, from the board's stats. */
  left: number;
}) {
  const loading = useBoard((state) => state.moreLoading !== null);
  const loadMore = useBoard((state) => state.loadMore);
  if (!groups.length) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground w-full justify-center gap-1.5 text-xs"
      disabled={loading}
      onClick={async () => {
        for (const group of groups) await loadMore(group);
      }}
    >
      {loading ? (
        "Loading…"
      ) : (
        <>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          Load more
          {/* How many are left, set apart by weight rather than a "·". */}
          {left > 0 && (
            <span className="tabular-nums opacity-60">{left} left</span>
          )}
        </>
      )}
    </Button>
  );
}
