/** Shared by the pre-hydration shell and the pending session gate. */
export function StartupLoading() {
  return (
    <div className="startup-loading flex min-h-svh flex-col bg-background text-foreground">
      <div
        className="startup-loading-titlebar h-14 shrink-0"
        aria-hidden="true"
      />
      <main className="flex flex-1 items-center justify-center px-6 pb-14">
        <div role="status" className="flex flex-col items-center gap-5">
          <div aria-hidden="true" className="flex h-8 items-center gap-1.5">
            <span className="startup-loading-lane h-5 w-1.5 rounded-full bg-primary" />
            <span className="startup-loading-lane h-8 w-1.5 rounded-full bg-primary" />
            <span className="startup-loading-lane h-6 w-1.5 rounded-full bg-primary" />
          </div>
          <div className="flex flex-col items-center gap-2">
            <span
              aria-hidden="true"
              className="text-xl font-semibold tracking-tight"
            >
              Lanework
            </span>
            <p className="text-sm text-muted-foreground">Opening Lanework…</p>
          </div>
        </div>
      </main>
    </div>
  );
}
