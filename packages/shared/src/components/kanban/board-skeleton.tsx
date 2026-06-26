import { Skeleton } from "@/components/ui/skeleton";

/** Full-screen placeholder shown while a board's data loads. Mirrors AppShell. */
export function BoardSkeleton({ owner, repo }: { owner: string; repo: string }) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-200/60 p-2 dark:bg-neutral-900 sm:p-3">
      <div className="flex h-full overflow-hidden rounded-2xl border bg-background shadow-sm">
        {/* Sidebar */}
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r bg-sidebar p-3">
          <Skeleton className="mt-1 h-10 w-full rounded-lg" />
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3 w-12" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-lg" />
            ))}
          </div>
          <div className="mt-auto">
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </aside>

        {/* Main */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="px-6 pt-5">
            <p className="text-sm text-muted-foreground">{owner}</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">{repo}</h1>
            <div className="mt-4 flex gap-2 border-b pb-2">
              <Skeleton className="h-7 w-16 rounded-lg" />
              <Skeleton className="h-7 w-14 rounded-lg" />
              <Skeleton className="h-7 w-20 rounded-lg" />
            </div>
          </div>

          <div className="flex flex-1 gap-4 overflow-hidden px-6 pt-5 pb-6">
            {Array.from({ length: 4 }).map((_, c) => (
              <div key={c} className="flex w-80 shrink-0 flex-col rounded-2xl bg-muted/40">
                <div className="flex items-center gap-2 px-4 py-3">
                  <Skeleton className="size-2 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <div className="flex flex-col gap-2.5 px-2.5 pb-2.5">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <CardSkeleton key={i} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-3.5">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-2/5" />
      <div className="flex items-center gap-3 border-t pt-2.5">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-8" />
        <Skeleton className="ml-auto h-4 w-10 rounded-md" />
      </div>
    </div>
  );
}
