import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  barTone,
  clamp,
  NEARLY_SPENT,
  resetDuration,
  type UsageWindow,
} from "#/lib/agent-usage";
import { cn } from "#/lib/utils";

/**
 * One limit: its name, when it resets, how full it is, and the bar.
 *
 * Used in Settings › Agents and in the terminal bar's popover. A window with
 * no numbers says so rather than drawing an empty bar that reads as 0%.
 */
export function UsageBar({
  name,
  label,
  region,
  window,
  now,
}: {
  name: string;
  label: string;
  /** The region's accessible name: "5-hour limit". */
  region: string;
  window: UsageWindow | null;
  now: number;
}) {
  const used = window ? clamp(window.usedPercent) : null;
  const reset =
    window?.resetsAt == null ? null : resetDuration(window.resetsAt - now);
  return (
    <section aria-label={region} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span
          className="text-muted-foreground flex min-w-0 items-center gap-2 tabular-nums"
          title={
            window?.resetsAt == null
              ? undefined
              : `Resets ${new Date(window.resetsAt).toLocaleString()}`
          }
        >
          <span className="text-foreground/80 shrink-0">{label}</span>
          {used === null ? (
            <span className="truncate">No usage data yet</span>
          ) : (
            reset !== null && (
              <span className="flex min-w-0 items-center gap-1">
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="size-3 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="truncate">
                  {reset === "now" ? "Resets now" : `Resets in ${reset}`}
                </span>
              </span>
            )
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            used !== null && used >= NEARLY_SPENT && "text-tone-amber",
          )}
        >
          {used === null ? "—" : `${Math.round(used)}%`}
        </span>
      </div>
      <div
        className="bg-foreground/10 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${name} ${label.toLowerCase()} usage limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used === null ? undefined : Math.round(used)}
      >
        {used !== null && (
          <span
            className={cn("block h-full rounded-full", barTone(used))}
            style={{ width: `${used}%` }}
          />
        )}
      </div>
    </section>
  );
}
