import { useEffect, useMemo, useState } from "react";
import { motion, type Variants } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Coins01Icon, AiBrain01Icon, Message01Icon } from "@hugeicons/core-free-icons";
import { getCostEstimate } from "@/server/reviews";
import type { CostData, ModelUsage } from "@/lib/local-fs";
import { estimateCost } from "@/lib/claude-pricing";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** Compact token count: 1234 → 1.2K, 1.2M, 3.59B, 1.04T. */
function compact(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const EASE = [0.22, 1, 0.36, 1] as const;
// Top-level reveal: headline → table → disclaimer, staggered.
const CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};
const ITEM: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
};
// The table fades in and staggers its own model rows.
const TABLE: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, staggerChildren: 0.05, delayChildren: 0.12 } },
};
const ROW: Variants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } },
};

function modelLabel(id: string): string {
  return id
    .replace(/^claude-/, "")
    .replace(/-(\d)/g, " $1")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CostView({ repo }: { repo: string }) {
  const [data, setData] = useState<CostData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getCostEstimate()
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load cost."));
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.models
      .map((m) => ({ ...m, cost: estimateCost(m.model, costInputs(m)) }))
      .sort((a, b) => b.cost - a.cost);
  }, [data]);

  const totals = useMemo(() => {
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const tokens = rows.reduce(
      (s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h,
      0,
    );
    const messages = rows.reduce((s, r) => s + r.messages, 0);
    return { cost, tokens, messages };
  }, [rows]);

  return (
    <div className="h-full overflow-y-auto px-6 pb-12">
      <div className="mx-auto max-w-3xl">
        {error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : data === null ? (
          <Loading />
        ) : !data.available ? (
          <Empty repo={repo} />
        ) : (
          <motion.div variants={CONTAINER} initial="hidden" animate="show">
            {/* Headline */}
            <motion.div
              variants={ITEM}
              className="rounded-2xl border bg-gradient-to-br from-primary/5 to-transparent p-6"
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <HugeiconsIcon icon={Coins01Icon} className="size-4 text-primary" />
                Estimated Claude Code spend · {repo}
              </div>
              <div className="mt-2 font-heading text-4xl font-semibold tracking-tight tabular-nums">
                {usd(totals.cost)}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <Stat icon={Message01Icon} label="messages" value={totals.messages.toLocaleString("en-US")} />
                <Stat icon={AiBrain01Icon} label="tokens" value={compact(totals.tokens)} />
                <span className="tabular-nums">{data.sessions} sessions</span>
                {data.firstAt && data.lastAt ? (
                  <span>
                    {fmtDay(data.firstAt)} – {fmtDay(data.lastAt)}
                  </span>
                ) : null}
              </div>
            </motion.div>

            {/* Per-model breakdown */}
            <motion.div variants={TABLE} className="mt-6 overflow-hidden rounded-xl border">
              <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                <span>Model</span>
                <span className="hidden text-right sm:block">Input / Output</span>
                <span className="hidden text-right sm:block">Cache (r/w)</span>
                <span className="text-right">Cost</span>
              </div>
              {rows.map((r) => (
                <ModelRow key={r.model} row={r} totalCost={totals.cost} />
              ))}
            </motion.div>

            <motion.p variants={ITEM} className="mt-4 text-xs text-muted-foreground">
              Estimated from{" "}
              <code className="rounded bg-muted px-1 py-0.5">~/.claude/projects</code> transcripts using
              public list prices (cache reads ≈ 0.1×, writes 1.25–2× input). Excludes discounts, batch, and
              priority-tier pricing.
            </motion.p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function ModelRow({ row, totalCost }: { row: ModelUsage & { cost: number }; totalCost: number }) {
  const pct = totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0;
  return (
    <motion.div
      variants={ROW}
      className="relative grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b px-4 py-2.5 text-sm last:border-b-0"
    >
      {/* Cost-share bar behind the row — grows to its share on reveal. */}
      <motion.span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-primary/5"
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.25 }}
      />
      <div className="relative min-w-0">
        <span className="font-medium">{modelLabel(row.model)}</span>
        <span className="ml-2 text-xs text-muted-foreground tabular-nums">{row.messages.toLocaleString("en-US")} msgs</span>
      </div>
      <span className="relative hidden text-right text-xs text-muted-foreground tabular-nums sm:block">
        {compact(row.input)} / {compact(row.output)}
      </span>
      <span className="relative hidden text-right text-xs text-muted-foreground tabular-nums sm:block">
        {compact(row.cacheRead)} / {compact(row.cacheWrite5m + row.cacheWrite1h)}
      </span>
      <span className="relative text-right font-medium tabular-nums">{usd(row.cost)}</span>
    </motion.div>
  );
}

function Stat({ icon, label, value }: { icon: typeof Coins01Icon; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <HugeiconsIcon icon={icon} className="size-3.5" />
      <span className="font-medium text-foreground tabular-nums">{value}</span> {label}
    </span>
  );
}

function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function Empty({ repo }: { repo: string }) {
  return (
    <div className="grid place-items-center py-16 text-center">
      <HugeiconsIcon icon={Coins01Icon} className="size-8 text-muted-foreground/50" />
      <h2 className="mt-3 text-base font-medium">No Claude Code sessions found</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        No transcripts under <code className="rounded bg-muted px-1 py-0.5">~/.claude/projects</code> match{" "}
        <span className="font-medium">{repo}</span>. Run Claude Code in this directory and the cost estimate
        will appear here.
      </p>
    </div>
  );
}

function costInputs(m: ModelUsage) {
  return {
    input: m.input,
    output: m.output,
    cacheRead: m.cacheRead,
    cacheWrite5m: m.cacheWrite5m,
    cacheWrite1h: m.cacheWrite1h,
  };
}

function fmtDay(iso: string): string {
  // iso like 2026-06-25T...; show the date portion compactly without Date APIs.
  const d = iso.slice(0, 10);
  return d;
}
