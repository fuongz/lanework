// Display helpers for agent-run telemetry (LastRun), shared by the card badge
// and the review dialog so cost/result formatting stays consistent.

/** Estimated USD cost, card-sized: `$0`, `<$0.01`, `$0.42`. */
export function formatRunCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Compact token count: `812`, `8.1k`, `1.2M`. */
export function formatRunTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Tailwind classes for a run-result pill (done / failed / stopped). */
export function runResultClass(result: string | null): string {
  switch (result) {
    case "done":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "failed":
      return "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300";
    case "stopped":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
