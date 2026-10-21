import { Skeleton } from "#/components/ui/skeleton";

/**
 * Loading states shaped like the thing that is coming.
 *
 * NOTE: Sized to the real rows — the issue list's two-line rows under a 32px
 * group header — so the first paint does not jump. A spinner in the middle of
 * an empty pane says "something is happening"; this says what, and it costs
 * the same.
 *
 * NOTE: Each carries a `role="status"` with a real label, because a screen
 * reader gets nothing at all from a grid of grey rectangles.
 */
export function IssuesListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this board"
      className="flex flex-col"
    >
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="flex h-8 items-center gap-2 px-3">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-1.5 px-5 py-2.5">
              <div className="flex h-4 items-center gap-1.5">
                <Skeleton className="size-3.5 shrink-0 rounded-full" />
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="ml-auto h-2.5 w-12" />
              </div>
              <Skeleton
                className="h-3.5"
                style={{ width: `${74 - row * 8 + group * 6}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The card's body while it loads.
 *
 * ⚠️ The document only. The properties rail is a pane of its own on that page —
 * it draws its own frame before the card lands — so a rail drawn in here too
 * would put two of them side by side.
 */
export function IssueDetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this card"
      className="flex min-w-0 flex-col gap-5 px-6 py-6"
    >
      <Skeleton className="h-6 w-2/3" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-20" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-2.5">
            <Skeleton className="size-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The rail's four rows, shaped like the `Row` they are about to become. */
export function PropertiesSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this card's properties"
      className="flex flex-col gap-0.5"
    >
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex min-h-8 items-center gap-2 px-1">
          <Skeleton className="h-2.5 w-14 shrink-0" />
          <Skeleton className="h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

/** The rail's project list before the account has answered. */
export function ProjectListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your projects"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-4 w-32" />
      <div className="flex flex-col gap-1">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex h-9 items-center gap-2.5 px-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
