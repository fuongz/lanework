import {
  PlusSignIcon,
  Refresh01Icon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Automation } from "#/../shared/automations";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/utils";
import { useAutomations } from "#/stores/automations";
import { describeSchedule, fullTime, untilTime } from "./automation-format";

/** Re-draws every half minute, so "in 3 minutes" counts down. */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

/** When it runs next, in words; or why it does not. */
export function nextRunText(automation: Automation, now: number): string {
  if (!automation.enabled) return "Paused";
  if (!automation.nextRunAt)
    return automation.schedule.kind === "once" ? "Done" : "Not scheduled";
  return `Next ${untilTime(automation.nextRunAt, now)}`;
}

/** The enabled switch, on a row and on the detail's header. */
export function EnabledSwitch({ automation }: { automation: Automation }) {
  const setEnabled = useAutomations((state) => state.setEnabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <Switch
      aria-label={`${automation.enabled ? "Pause" : "Resume"} ${automation.name}`}
      title={error ?? (automation.enabled ? "On" : "Paused")}
      checked={automation.enabled}
      onCheckedChange={(enabled) =>
        void setEnabled(automation.id, enabled).then((result) =>
          setError(result.error ?? null),
        )
      }
    />
  );
}

/** One automation: its name, when it runs, when next, and its switch. */
function Row({
  automation,
  slug,
  now,
}: {
  automation: Automation;
  slug: string;
  now: number;
}) {
  return (
    <li className="relative">
      <Link
        to="/w/$slug/automations/$id"
        params={{ slug, id: automation.id }}
        className={`${RAIL_ROW} focus-visible:ring-accent-brand flex flex-col gap-0.5 rounded-lg py-2 ps-3 pe-14 outline-none focus-visible:ring-2`}
        activeProps={{ className: "bg-foreground/[0.06]" }}
      >
        <span
          className={cn(
            "min-w-0 truncate text-[13px] font-medium",
            !automation.enabled && "text-muted-foreground",
          )}
        >
          {automation.name}
        </span>
        {/* Under the name, set apart by space rather than "·". */}
        <span className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
          <span className="min-w-0 truncate">
            {describeSchedule(automation.schedule, automation.timezone)}
          </span>
          <span
            className="ml-auto shrink-0 tabular-nums"
            title={fullTime(automation.nextRunAt)}
          >
            {nextRunText(automation, now)}
          </span>
        </span>
      </Link>
      {/* Beside the link, not in it: flipping it must not open the row. */}
      <span className="absolute inset-y-0 end-3 flex items-center">
        <EnabledSwitch automation={automation} />
      </span>
    </li>
  );
}

/** The left pane: a project's automations, by name. */
export function AutomationsList() {
  const { slug } = useParams({ from: "/_app/w/$slug/automations" });
  const automations = useAutomations((state) => state.automations);
  const error = useAutomations((state) => state.error);
  const loading = useAutomations((state) => state.loading);
  const refresh = useAutomations((state) => state.refresh);
  const openEditor = useAutomations((state) => state.openEditor);
  const now = useNow();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WindowTitlebar className="justify-between pe-3">
        <h1 className={WINDOW_TITLE}>Automations</h1>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh automations"
            title="Refresh"
            className="hover:bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className={cn(
                "text-muted-foreground size-3.5",
                loading && "animate-spin",
              )}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openEditor({ kind: "new" })}
          >
            <HugeiconsIcon
              icon={PlusSignIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            New
          </Button>
        </span>
      </WindowTitlebar>
      <ScrollArea className="flex-1">
        {error && (
          <p className="text-destructive px-4 py-3 text-xs/relaxed">{error}</p>
        )}
        {!automations && !error && (
          <ListSkeleton label="Reading the automations" lines={2} rows={4} />
        )}
        {automations && automations.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>No automations yet</EmptyTitle>
              <EmptyDescription>
                New adds one: a prompt, an agent and when it runs.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {automations && automations.length > 0 && (
          <RailHover backgroundClassName="rounded-lg bg-foreground/[0.03]">
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {automations.map((automation) => (
                <Row
                  key={automation.id}
                  automation={automation}
                  slug={slug}
                  now={now}
                />
              ))}
            </ul>
          </RailHover>
        )}
      </ScrollArea>
    </div>
  );
}
