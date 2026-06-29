import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon } from "@hugeicons/core-free-icons";
import { getUsageSummary } from "@/server/reviews";
import { estimateCost } from "@/lib/claude-pricing";

type Summary = Awaited<ReturnType<typeof getUsageSummary>>;
type Models = Summary["weekly"];

const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function summarize(models: Models) {
  let cost = 0;
  let tokens = 0;
  for (const m of models) {
    cost += estimateCost(m.model, {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite5m: m.cacheWrite5m,
      cacheWrite1h: m.cacheWrite1h,
    });
    tokens += m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
  }
  return { cost, tokens };
}

/**
 * Claude usage at the bottom of the sidebar: this week + the current session,
 * priced from `~/.claude` transcripts. Local mode only; refreshes every 30s.
 */
export function UsageFooter() {
  const [data, setData] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getUsageSummary()
        .then((d) => !cancelled && setData(d))
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data?.available) return null;
  const week = summarize(data.weekly);
  const session = summarize(data.session);
  if (week.tokens === 0 && session.tokens === 0) return null;

  return (
    <div className="rounded-lg border bg-sidebar-accent/40 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <HugeiconsIcon icon={Coins01Icon} className="size-3.5" />
        Claude usage
      </div>
      <Row label="This week" cost={week.cost} tokens={week.tokens} />
      <Row label="This session" cost={session.cost} tokens={session.tokens} />
    </div>
  );
}

function Row({ label, cost, tokens }: { label: string; cost: number; tokens: number }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className="font-medium text-foreground">{usd(cost)}</span>
        <span className="ml-1.5 text-muted-foreground">{fmtTokens(tokens)} tok</span>
      </span>
    </div>
  );
}
