import { Button } from "#/components/ui/button";
import { useBoard } from "#/stores/board";

/**
 * The last row of a group that has more on the service than on screen (FE-17).
 *
 * ⚠️ It reads the store itself rather than taking a callback, so a lane that
 * is `memo`ed on its cards does not re-render every time another group's page
 * lands. It renders nothing for a group that is complete — including every
 * group of a board read whole from an older service, which has no cursors.
 */
export function LoadMore({
  group,
  loaded,
  count,
  label,
}: {
  group: string;
  /** Cards of this group on screen now. */
  loaded: number;
  /** Cards of this group on the service, from the board's stats. */
  count: number;
  /** What the group is called, for the button's accessible name. */
  label: string;
}) {
  const cursor = useBoard((state) => state.view?.groups?.[group]?.cursor);
  const loading = useBoard((state) => state.moreLoading === group);
  const loadMore = useBoard((state) => state.loadMore);
  if (!cursor) return null;
  const left = Math.max(count - loaded, 0);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground w-full justify-center text-xs"
      disabled={loading}
      aria-label={`Load more in ${label}`}
      onClick={() => void loadMore(group)}
    >
      {loading ? "Loading…" : left ? `Load more · ${left} left` : "Load more"}
    </Button>
  );
}
