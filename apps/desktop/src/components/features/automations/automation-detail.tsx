import {
  Delete02Icon,
  PencilEdit02Icon,
  PlayIcon,
  TimeScheduleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
} from "#/../shared/automations";
import {
  AGENT_LABELS,
  modelName,
  PERMISSION_COPY,
} from "#/../shared/conversation";
import {
  describeSchedule,
  duration,
  fullTime,
  STATUS_LABELS,
  TRIGGER_LABELS,
} from "#/components/shared/automations/automation-format";
import { AutomationTrust } from "#/components/shared/automations/automation-trust";
import {
  EnabledSwitch,
  nextRunText,
  useNow,
} from "#/components/shared/automations/automations-list";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
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
import { useAutomations } from "#/stores/automations";

const STATUS_TONE: Record<AutomationRunStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-rose-600 dark:text-rose-400",
  timed_out: "text-rose-600 dark:text-rose-400",
  skipped: "text-muted-foreground",
  nothing_to_report: "text-muted-foreground",
};

const STATUS_DOT: Record<AutomationRunStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-sky-500 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-rose-500",
  timed_out: "bg-rose-500",
  skipped: "bg-muted-foreground/30",
  nothing_to_report: "bg-muted-foreground/50",
};

/** One fact in the summary: a quiet label over its value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
  );
}

function Summary({ automation, now }: { automation: Automation; now: number }) {
  const model = modelName(automation.settings.model) ?? "";
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border px-4 py-3.5 lg:grid-cols-3">
      <Fact label="Schedule">
        <span title={automation.timezone}>
          {describeSchedule(automation.schedule, automation.timezone)}
        </span>
      </Fact>
      <Fact label="Next run">
        <span title={fullTime(automation.nextRunAt)}>
          {nextRunText(automation, now)}
        </span>
      </Fact>
      <Fact label="Time zone">{automation.timezone}</Fact>
      <Fact label="Agent">
        {AGENT_LABELS[automation.agent]} {model}
      </Fact>
      <Fact label="Permissions">
        {PERMISSION_COPY[automation.settings.permission].label}
      </Fact>
      <Fact label="Workspace">
        {automation.workspace === "worktree"
          ? "New worktree per run"
          : "Project folder"}
      </Fact>
      <Fact label="Grace">{automation.graceMinutes} min</Fact>
      <Fact label="Timeout">{automation.timeoutMinutes} min</Fact>
    </dl>
  );
}

/** One run as a table row; its conversation opens in Agents. */
function RunRow({
  run,
  slug,
  now,
}: {
  run: AutomationRun;
  slug: string;
  now: number;
}) {
  return (
    <tr className="border-t">
      <td className="py-2 pe-4">
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
      </td>
      <td className="text-muted-foreground py-2 pe-4">
        {TRIGGER_LABELS[run.trigger]}
      </td>
      <td className="py-2 pe-4 tabular-nums">
        {fullTime(run.startedAt ?? run.scheduledFor)}
      </td>
      <td className="text-muted-foreground py-2 pe-4 tabular-nums">
        {duration(run.startedAt, run.endedAt, now)}
      </td>
      <td className="py-2 text-end">
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
  automation,
  slug,
  now,
}: {
  automation: Automation;
  slug: string;
  now: number;
}) {
  const runs = useAutomations((state) => state.runs[automation.id]);
  const error = useAutomations((state) => state.runsError[automation.id]);
  return (
    <section
      aria-labelledby="automation-history"
      className="flex flex-col gap-2"
    >
      <h2 id="automation-history" className="text-[13px] font-medium">
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
  automation,
  open,
  onOpenChange,
  onDeleted,
}: {
  automation: Automation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useAutomations((state) => state.remove);
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
          <AlertDialogTitle>Delete {automation.name}?</AlertDialogTitle>
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
              void remove(automation.id)
                .then(onDeleted)
                .catch((failure: unknown) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Could not delete the automation.",
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

/** One automation: what it does, when, Run now, and its runs. */
export function AutomationDetail() {
  const { slug, id } = useParams({ from: "/_app/w/$slug/automations/$id" });
  const navigate = useNavigate();
  const automations = useAutomations((state) => state.automations);
  const automation = automations?.find((entry) => entry.id === id);
  const loadRuns = useAutomations((state) => state.loadRuns);
  const runNow = useAutomations((state) => state.runNow);
  const openEditor = useAutomations((state) => state.openEditor);
  const running = useAutomations((state) =>
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

  if (!automation) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowTitlebar>
          <h1 className={WINDOW_TITLE}>Automations</h1>
        </WindowTitlebar>
        {automations && (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={TimeScheduleIcon} strokeWidth={1.8} />
              </EmptyMedia>
              <EmptyTitle>Automation not found</EmptyTitle>
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
          <h1 className={WINDOW_TITLE}>{automation.name}</h1>
          <EnabledSwitch automation={automation} />
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Edit automation"
            title="Edit"
            onClick={() => openEditor({ kind: "edit", id: automation.id })}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete automation"
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
              void runNow(automation.id)
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
          <Summary automation={automation} now={now} />
          <AutomationTrust slug={slug} agent={automation.agent} />
          <section
            aria-labelledby="automation-prompt"
            className="flex flex-col gap-2"
          >
            <h2 id="automation-prompt" className="text-[13px] font-medium">
              Prompt
            </h2>
            <p className="bg-foreground/[0.03] rounded-lg px-3.5 py-3 text-xs/relaxed whitespace-pre-wrap">
              {automation.prompt}
            </p>
          </section>
          <History automation={automation} slug={slug} now={now} />
        </div>
      </ScrollArea>
      <DeleteDialog
        automation={automation}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          setDeleting(false);
          void navigate({ to: "/w/$slug/automations", params: { slug } });
        }}
      />
    </div>
  );
}
