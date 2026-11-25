import {
  PlusSignIcon,
  Refresh01Icon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Routine } from "#/../shared/routines";
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
import { useRoutines } from "#/stores/routines";
import { describeSchedule, fullTime, untilTime } from "./routine-format";

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
export function nextRunText(routine: Routine, now: number): string {
  if (!routine.enabled) return "Paused";
  if (!routine.nextRunAt)
    return routine.schedule.kind === "once" ? "Done" : "Not scheduled";
  return `Next ${untilTime(routine.nextRunAt, now)}`;
}

/** The enabled switch, on a row and on the detail's header. */
export function EnabledSwitch({ routine }: { routine: Routine }) {
  const setEnabled = useRoutines((state) => state.setEnabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <Switch
      aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
      title={error ?? (routine.enabled ? "On" : "Paused")}
      checked={routine.enabled}
      onCheckedChange={(enabled) =>
        void setEnabled(routine.id, enabled).then((result) =>
          setError(result.error ?? null),
        )
      }
    />
  );
}

/** One routine: its name, when it runs, when next, and its switch. */
function Row({
  routine,
  slug,
  now,
}: {
  routine: Routine;
  slug: string;
  now: number;
}) {
  return (
    <li className="relative">
      <Link
        to="/w/$slug/routines/$id"
        params={{ slug, id: routine.id }}
        className={`${RAIL_ROW} focus-visible:ring-accent-brand flex flex-col gap-0.5 rounded-lg py-2 ps-3 pe-14 outline-none focus-visible:ring-2`}
        activeProps={{ className: "bg-foreground/[0.06]" }}
      >
        <span
          className={cn(
            "min-w-0 truncate text-[13px] font-medium",
            !routine.enabled && "text-muted-foreground",
          )}
        >
          {routine.name}
        </span>
        {/* Under the name, set apart by space rather than "·". */}
        <span className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
          <span className="min-w-0 truncate">
            {describeSchedule(routine.schedule, routine.timezone)}
          </span>
          <span
            className="ml-auto shrink-0 tabular-nums"
            title={fullTime(routine.nextRunAt)}
          >
            {nextRunText(routine, now)}
          </span>
        </span>
      </Link>
      {/* Beside the link, not in it: flipping it must not open the row. */}
      <span className="absolute inset-y-0 end-3 flex items-center">
        <EnabledSwitch routine={routine} />
      </span>
    </li>
  );
}

/** The left pane: a project's routines, by name. */
export function RoutinesList() {
  const { slug } = useParams({ from: "/_app/w/$slug/routines" });
  const routines = useRoutines((state) => state.routines);
  const error = useRoutines((state) => state.error);
  const loading = useRoutines((state) => state.loading);
  const refresh = useRoutines((state) => state.refresh);
  const openEditor = useRoutines((state) => state.openEditor);
  const now = useNow();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WindowTitlebar className="justify-between pe-3">
        <h1 className={WINDOW_TITLE}>Routines</h1>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh routines"
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
        {!routines && !error && (
          <ListSkeleton label="Reading the routines" lines={2} rows={4} />
        )}
        {routines && routines.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>No routines yet</EmptyTitle>
              <EmptyDescription>
                New adds one: a prompt, an agent and when it runs.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {routines && routines.length > 0 && (
          <RailHover backgroundClassName="rounded-lg bg-foreground/[0.03]">
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {routines.map((routine) => (
                <Row key={routine.id} routine={routine} slug={slug} now={now} />
              ))}
            </ul>
          </RailHover>
        )}
      </ScrollArea>
    </div>
  );
}
