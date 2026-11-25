import {
  Delete02Icon,
  PencilEdit02Icon,
  PlayIcon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
  AGENT_LABELS,
  modelName,
  PERMISSION_COPY,
} from "#/../shared/conversation";
import type {
  Routine,
  RoutineRun,
  RoutineRunStatus,
} from "#/../shared/routines";
import { costText, tokenText } from "#/components/shared/agents/facts";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  describeSchedule,
  duration,
  fullTime,
  STATUS_LABELS,
  TRIGGER_LABELS,
} from "#/components/shared/routines/routine-format";
import { RoutineTrust } from "#/components/shared/routines/routine-trust";
import {
  EnabledSwitch,
  nextRunText,
  useNow,
} from "#/components/shared/routines/routines-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ScrollArea } from "#/components/ui/scroll-area";
import { cn } from "#/lib/utils";
import { useRoutines } from "#/stores/routines";

const STATUS_TONE: Record<RoutineRunStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-rose-600 dark:text-rose-400",
  timed_out: "text-rose-600 dark:text-rose-400",
  skipped: "text-muted-foreground",
  nothing_to_report: "text-muted-foreground",
};

const STATUS_DOT: Record<RoutineRunStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-sky-500 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-rose-500",
  timed_out: "bg-rose-500",
  skipped: "bg-muted-foreground/30",
  nothing_to_report: "bg-muted-foreground/50",
};

/** What a cost is (FE-177/D3): the CLI's price, not a bill. */
const COST_HINT =
  "Estimated by Claude Code at API prices. On a Claude subscription this is not what you are billed.";

/** How far back the summary's spend reaches (FE-177/D5). */
const SPEND_DAYS = 7;

/** A run's tokens, read in and written out, short; null when untold. */
function tokensText(run: RoutineRun): string | null {
  if (!run.tokens) return null;
  const read = run.tokens.input + run.tokens.cached;
  return `${tokenText(read)} in, ${tokenText(run.tokens.output)} out`;
}

/** A run's tokens in full, for its tooltip. */
function tokensTitle(run: RoutineRun): string | undefined {
  if (!run.tokens) return undefined;
  const { input, cached, output } = run.tokens;
  return `${input.toLocaleString()} input, ${cached.toLocaleString()} from cache, ${output.toLocaleString()} output`;
}

/**
 * The runs of the last {@link SPEND_DAYS} days, summed (FE-177/D5): what
 * they cost when any said, else the tokens they used. Null with neither.
 */
function spendOf(
  runs: readonly RoutineRun[],
  now: number,
): { text: string; priced: boolean } | null {
  const since = now - SPEND_DAYS * 24 * 3600_000;
  const recent = runs.filter((run) => {
    const at = Date.parse(run.startedAt ?? run.scheduledFor);
    return Number.isFinite(at) && at >= since;
  });
  const costs = recent.flatMap((run) =>
    run.costUSD === null ? [] : [run.costUSD],
  );
  const count = `${recent.length} ${recent.length === 1 ? "run" : "runs"}`;
  if (costs.length)
    return {
      text: `${costText(costs.reduce((sum, cost) => sum + cost, 0))} over ${count}`,
      priced: true,
    };
  const tokens = recent.reduce(
    (sum, run) =>
      sum +
      (run.tokens
        ? run.tokens.input + run.tokens.cached + run.tokens.output
        : 0),
    0,
  );
  return tokens
    ? { text: `${tokenText(tokens)} tokens over ${count}`, priced: false }
    : null;
}

/** One fact in the summary: a quiet label over its value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
  );
}

function Summary({ routine, now }: { routine: Routine; now: number }) {
  const model = modelName(routine.settings.model) ?? "";
  const runs = useRoutines((state) => state.runs[routine.id]);
  const spend = runs ? spendOf(runs, now) : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border px-4 py-3.5 lg:grid-cols-3">
      <Fact label="Schedule">
        <span title={routine.timezone}>
          {describeSchedule(routine.schedule, routine.timezone)}
        </span>
      </Fact>
      <Fact label="Next run">
        <span title={fullTime(routine.nextRunAt)}>
          {nextRunText(routine, now)}
        </span>
      </Fact>
      <Fact label="Time zone">{routine.timezone}</Fact>
      <Fact label="Agent">
        {AGENT_LABELS[routine.agent]} {model}
      </Fact>
      <Fact label="Permissions">
        {PERMISSION_COPY[routine.settings.permission].label}
      </Fact>
      <Fact label="Workspace">
        {routine.workspace === "worktree"
          ? "New worktree per run"
          : "Project folder"}
      </Fact>
      <Fact label="Grace">{routine.graceMinutes} min</Fact>
      <Fact label="Timeout">{routine.timeoutMinutes} min</Fact>
      <Fact label={`Last ${SPEND_DAYS} days`}>
        <span
          className={cn("tabular-nums", !spend && "text-muted-foreground")}
          title={spend?.priced ? COST_HINT : undefined}
        >
          {spend?.text ?? "Nothing used yet"}
        </span>
      </Fact>
    </dl>
  );
}

/** One run as a table row; its conversation opens in Agents. */
function RunRow({
  run,
  slug,
  now,
}: {
  run: RoutineRun;
  slug: string;
  now: number;
}) {
  return (
    <tr className="border-t">
      <td className="max-w-72 py-2 pe-4 align-top">
        <span
          className={cn("flex items-center gap-2", STATUS_TONE[run.status])}
          title={run.error ?? undefined}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[run.status],
            )}
          />
          {STATUS_LABELS[run.status]}
        </span>
        {run.note && (
          // What a self-paced run said of its pace (FE-172), under the dot.
          <p
            className="text-muted-foreground mt-0.5 truncate ps-3.5"
            title={run.note}
          >
            {run.note}
          </p>
        )}
      </td>
      <td className="text-muted-foreground py-2 pe-4 align-top">
        {TRIGGER_LABELS[run.trigger]}
      </td>
      <td className="py-2 pe-4 tabular-nums align-top">
        {fullTime(run.startedAt ?? run.scheduledFor)}
      </td>
      <td className="text-muted-foreground py-2 pe-4 tabular-nums align-top">
        {duration(run.startedAt, run.endedAt, now)}
      </td>
      <td
        className="text-muted-foreground py-2 pe-4 tabular-nums align-top whitespace-nowrap"
        title={tokensTitle(run)}
      >
        {tokensText(run)}
      </td>
      <td
        className="text-muted-foreground py-2 pe-4 tabular-nums align-top"
        title={run.costUSD === null ? undefined : COST_HINT}
      >
        {run.costUSD === null ? null : costText(run.costUSD)}
      </td>
      <td className="py-2 text-end align-top">
        {run.conversation ? (
          <Link
            to="/w/$slug/agents/chat/$conversation"
            params={{ slug, conversation: run.conversation }}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Open
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

function History({
  routine,
  slug,
  now,
}: {
  routine: Routine;
  slug: string;
  now: number;
}) {
  const runs = useRoutines((state) => state.runs[routine.id]);
  const error = useRoutines((state) => state.runsError[routine.id]);
  return (
    <section aria-labelledby="routine-history" className="flex flex-col gap-2">
      <h2 id="routine-history" className="text-[13px] font-medium">
        History
      </h2>
      {error && <p className="text-destructive text-xs/relaxed">{error}</p>}
      {!runs && !error && (
        <ListSkeleton label="Reading the runs" rows={3} icon={false} />
      )}
      {runs && runs.length === 0 && (
        <p className="text-muted-foreground text-xs/relaxed">
          No runs yet. Run now starts one.
        </p>
      )}
      {runs && runs.length > 0 && (
        <table className="w-full text-start text-xs">
          <thead>
            <tr className="text-muted-foreground text-start">
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Status
              </th>
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Trigger
              </th>
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Started
              </th>
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Duration
              </th>
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Tokens
              </th>
              <th scope="col" className="py-1.5 pe-4 text-start font-normal">
                Cost
              </th>
              <th scope="col" className="py-1.5 text-end font-normal">
                <span className="sr-only">Conversation</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run.id} run={run} slug={slug} now={now} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeleteDialog({
  routine,
  open,
  onOpenChange,
  onDeleted,
}: {
  routine: Routine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useRoutines((state) => state.remove);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {routine.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {error ??
              "Its schedule and run history go. A run still going is stopped. Its conversations stay in Sessions."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="border-0"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void remove(routine.id)
                .then(onDeleted)
                .catch((failure: unknown) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Could not delete the routine.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One routine: what it does, when, Run now, and its runs. */
export function RoutineDetail() {
  const { slug, id } = useParams({ from: "/_app/w/$slug/routines/$id" });
  const navigate = useNavigate();
  const routines = useRoutines((state) => state.routines);
  const routine = routines?.find((entry) => entry.id === id);
  const loadRuns = useRoutines((state) => state.loadRuns);
  const runNow = useRoutines((state) => state.runNow);
  const openEditor = useRoutines((state) => state.openEditor);
  const running = useRoutines((state) =>
    (state.runs[id] ?? []).some(
      (run) => run.status === "running" || run.status === "queued",
    ),
  );
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Each second while a run is going, so its duration counts.
  const now = useNow(running ? 1000 : 30_000);

  useEffect(() => {
    setRunError(null);
    void loadRuns(id);
  }, [id, loadRuns]);

  if (!routine) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowTitlebar>
          <h1 className={WINDOW_TITLE}>Routines</h1>
        </WindowTitlebar>
        {routines && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>Routine not found</EmptyTitle>
              <EmptyDescription>
                It may have been deleted. Pick another from the list.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <WindowTitlebar className="justify-between">
        <span className="flex min-w-0 items-center gap-3">
          <h1 className={WINDOW_TITLE}>{routine.name}</h1>
          <EnabledSwitch routine={routine} />
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Edit routine"
            title="Edit"
            onClick={() => openEditor({ kind: "edit", id: routine.id })}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete routine"
            title="Delete"
            onClick={() => setDeleting(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
          </Button>
          <Button
            size="sm"
            disabled={starting || running}
            title={running ? "A run is already going" : undefined}
            onClick={() => {
              setStarting(true);
              void runNow(routine.id)
                .then((result) => setRunError(result.error ?? null))
                .finally(() => setStarting(false));
            }}
          >
            <HugeiconsIcon
              icon={PlayIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {starting ? "Starting…" : running ? "Running" : "Run now"}
          </Button>
        </span>
      </WindowTitlebar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 px-5 pt-1 pb-8">
          {runError && (
            <p role="alert" className="text-destructive text-xs/relaxed">
              {runError}
            </p>
          )}
          <Summary routine={routine} now={now} />
          <RoutineTrust slug={slug} agent={routine.agent} />
          <section
            aria-labelledby="routine-prompt"
            className="flex flex-col gap-2"
          >
            <h2 id="routine-prompt" className="text-[13px] font-medium">
              Prompt
            </h2>
            <p className="bg-foreground/[0.03] rounded-lg px-3.5 py-3 text-xs/relaxed whitespace-pre-wrap">
              {routine.prompt}
            </p>
          </section>
          <History routine={routine} slug={slug} now={now} />
        </div>
      </ScrollArea>
      <DeleteDialog
        routine={routine}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          setDeleting(false);
          void navigate({ to: "/w/$slug/routines", params: { slug } });
        }}
      />
    </div>
  );
}
