import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import {
  AGENT_LABELS,
  type ConversationAgent,
  EFFORT_LABELS,
  EFFORTS,
  type Effort,
  modelName,
} from "#/../shared/conversation";
import {
  type OrchestrationProposal,
  type OrchestrationRun,
  type ProposedTask,
  parseProposal,
  type TeamLead,
  WORKERS_MAX,
} from "#/../shared/orchestration";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { ipcMessage } from "#/lib/ipc-error";
import {
  catalog,
  DEFAULT_MAX_WORKERS,
  type DerivedProposal,
  leadIcon,
  tiersAllowed,
} from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { useProposalEdits } from "./orchestration-panel.store";

/** The model select's value for a task left to its tier. */
const AUTO = "auto";
/** The effort select's value for the model's own default. */
const DEFAULT_EFFORT = "default";
/** Tasks drawn before "Show more". */
const FOLDED = 4;

function modelValue(task: ProposedTask): string {
  return task.model ? `${task.agent ?? "claude"}:${task.model}` : AUTO;
}

/** "src/a, src/b" → its paths; blank entries dropped. */
function splitScopes(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A worker's model: one of the catalog's, or its tier's.
 *
 * Under a team lead, only its workers, and "Auto" only when they carry a
 * tier (FE-88).
 */
function ModelSelect({
  task,
  teamLead,
  disabled,
  onChange,
}: {
  task: ProposedTask;
  teamLead: TeamLead | null;
  disabled: boolean;
  onChange: (patch: Pick<ProposedTask, "agent" | "model">) => void;
}) {
  const models = catalog(teamLead);
  const auto = tiersAllowed(teamLead);
  const agents = (["claude", "codex"] as ConversationAgent[]).filter((agent) =>
    models.some((entry) => entry.agent === agent),
  );
  return (
    <Select
      value={modelValue(task)}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === AUTO || typeof next !== "string") {
          onChange({ agent: null, model: null });
          return;
        }
        const at = next.indexOf(":");
        onChange({
          agent: next.slice(0, at) as ConversationAgent,
          model: next.slice(at + 1),
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Model for ${task.title}`}
        className="max-w-48"
      >
        <SelectValue>
          {(value: string) =>
            value === AUTO ? (
              "Auto (by tier)"
            ) : (
              <>
                <TerminalKindIcon
                  kind={(task.agent ?? "claude") as ConversationAgent}
                  className="size-3"
                />
                <span className="truncate">
                  {modelName(task.model) ?? task.model}
                </span>
              </>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="end">
        {auto && <SelectItem value={AUTO}>Auto (by tier)</SelectItem>}
        {agents.map((agent) => (
          <SelectGroup key={agent}>
            <SelectLabel>{AGENT_LABELS[agent]}</SelectLabel>
            {models
              .filter((entry) => entry.agent === agent)
              .map((entry) => (
                <SelectItem
                  key={entry.model}
                  value={`${entry.agent}:${entry.model}`}
                >
                  <TerminalKindIcon kind={entry.agent} className="size-3" />
                  {entry.label}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function EffortSelect({
  task,
  disabled,
  onChange,
}: {
  task: ProposedTask;
  disabled: boolean;
  onChange: (effort: Effort | null) => void;
}) {
  return (
    <Select
      value={task.effort ?? DEFAULT_EFFORT}
      disabled={disabled}
      onValueChange={(next) =>
        onChange(
          next === DEFAULT_EFFORT || typeof next !== "string"
            ? null
            : (next as Effort),
        )
      }
    >
      <SelectTrigger size="sm" aria-label={`Effort for ${task.title}`}>
        <SelectValue>
          {(value: string) =>
            value === DEFAULT_EFFORT
              ? "Default effort"
              : EFFORT_LABELS[value as Effort]
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="end">
        <SelectItem value={DEFAULT_EFFORT}>Default effort</SelectItem>
        {EFFORTS.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {EFFORT_LABELS[effort]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Write scopes as one comma-separated line.
 *
 * NOTE: Kept as typed until the field is left: splitting on every key would
 * eat the ", " being typed between two paths.
 */
function ScopeField({
  id,
  task,
  disabled,
  onChange,
}: {
  id: string;
  task: ProposedTask;
  disabled: boolean;
  onChange: (files: string[]) => void;
}) {
  const joined = task.files.join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      id={id}
      value={draft ?? joined}
      disabled={disabled}
      placeholder='src/feature, docs — or "." for the whole checkout'
      aria-invalid={splitScopes(draft ?? joined).length === 0 || undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        onChange(splitScopes(draft));
        setDraft(null);
      }}
      className="font-mono"
    />
  );
}

function TaskRow({
  task,
  index,
  tasks,
  teamLead,
  editable,
  onChange,
}: {
  task: ProposedTask;
  index: number;
  tasks: ProposedTask[];
  teamLead: TeamLead | null;
  editable: boolean;
  onChange: (patch: Partial<ProposedTask>) => void;
}) {
  const [open, setOpen] = useState(false);
  const field = useId();
  const others = tasks.filter((entry) => entry.id !== task.id);
  const label = "text-muted-foreground mb-1 block text-[11px]";
  return (
    <li className="flex flex-col">
      <div className="hover:bg-foreground/[0.03] flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Details for ${task.title}`}
          onClick={() => setOpen(!open)}
          className="text-foreground/80 hover:text-foreground flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {index + 1}
          </span>
          <span className="truncate text-[13px]" title={task.title}>
            {task.title}
          </span>
        </button>
        <ModelSelect
          task={task}
          teamLead={teamLead}
          disabled={!editable}
          onChange={(patch) => onChange(patch)}
        />
        <EffortSelect
          task={task}
          disabled={!editable}
          onChange={(effort) => onChange({ effort })}
        />
      </div>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3 pl-9">
          <div>
            <label htmlFor={`${field}-title`} className={label}>
              Task
            </label>
            <Input
              id={`${field}-title`}
              value={task.title}
              disabled={!editable}
              onChange={(event) => onChange({ title: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor={`${field}-prompt`} className={label}>
              Instructions
            </label>
            <Textarea
              id={`${field}-prompt`}
              value={task.prompt}
              disabled={!editable}
              onChange={(event) => onChange({ prompt: event.target.value })}
              className="max-h-60"
            />
          </div>
          <div>
            <label htmlFor={`${field}-files`} className={label}>
              Write scopes
            </label>
            <ScopeField
              id={`${field}-files`}
              task={task}
              disabled={!editable}
              onChange={(files) => onChange({ files })}
            />
          </div>
          {others.length > 0 && (
            <fieldset className="flex flex-col">
              <legend className={label}>Starts after</legend>
              <div className="flex flex-wrap gap-1.5">
                {others.map((other) => {
                  const on = task.dependsOn.includes(other.id);
                  return (
                    <button
                      key={other.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!editable}
                      onClick={() =>
                        onChange({
                          dependsOn: on
                            ? task.dependsOn.filter((id) => id !== other.id)
                            : [...task.dependsOn, other.id],
                        })
                      }
                      className={cn(
                        "border-border max-w-56 truncate rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-60",
                        on
                          ? "bg-foreground/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tasks.indexOf(other) + 1}. {other.title}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The lead's proposal (FE-87): the tasks it would hand to workers, editable,
 * and nothing runs until Approve.
 *
 * Under a team lead (FE-88) it wears the lead's name and icon, offers only
 * its workers, and caps the parallel workers at its limit.
 */
export function ProposalCard({
  workspace,
  lead,
  leadAgent,
  proposal,
  teamLead,
  leadsRead,
  onRepair,
  onApproved,
}: {
  workspace: string;
  lead: string;
  leadAgent: ConversationAgent;
  proposal: DerivedProposal;
  /** The team lead `proposal.teamLead` names; null for none, or not found. */
  teamLead: TeamLead | null;
  /** The team leads were read: a named one not found is gone, not coming. */
  leadsRead: boolean;
  /** Sends the one repair prompt; false when it could not be sent. */
  onRepair: (proposal: DerivedProposal) => Promise<boolean>;
  onApproved: (run: OrchestrationRun) => void;
}) {
  const edits = useProposalEdits((state) => state.edits[proposal.id]);
  const patch = useProposalEdits((state) => state.patch);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const tasks = edits?.tasks ?? proposal.tasks;
  const workersCap = teamLead?.maxWorkers ?? WORKERS_MAX;
  const maxWorkers = Math.min(
    edits?.maxWorkers ?? teamLead?.maxWorkers ?? DEFAULT_MAX_WORKERS,
    workersCap,
  );
  const approved = Boolean(edits?.runId);
  const cancelled = Boolean(edits?.cancelled) && !approved;
  const planning = proposal.status === "planning";
  // Its team lead still being read: its workers are not known yet.
  const leadKnown = !proposal.teamLead || Boolean(teamLead) || leadsRead;
  const editable =
    proposal.status === "ready" &&
    !approved &&
    !cancelled &&
    !starting &&
    leadKnown;
  const visible = showAll ? tasks : tasks.slice(0, FOLDED);

  const change = (id: string, next: Partial<ProposedTask>) => {
    setError(null);
    patch(proposal.id, {
      tasks: tasks.map((task) =>
        task.id === id ? { ...task, ...next } : task,
      ),
    });
  };

  const approve = async () => {
    const surface = window.desktop?.orchestration;
    if (!surface) return;
    setError(null);
    const draft: OrchestrationProposal = {
      version: 1,
      id: proposal.id,
      workspace,
      lead,
      leadAgent,
      teamLead: proposal.teamLead,
      request: proposal.request,
      status: "ready",
      title: proposal.title,
      summary: proposal.summary,
      maxWorkers,
      tasks,
      error: null,
    };
    let checked: OrchestrationProposal;
    try {
      // The same check main runs: an emptied scope or a cycle the user made
      // is said here, on the card, before anything is asked of main.
      checked = parseProposal(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    setStarting(true);
    try {
      const run = await surface.approve(checked);
      patch(proposal.id, { runId: run.id });
      onApproved(run);
    } catch (caught) {
      setError(ipcMessage(caught, "Could not start the run."));
    } finally {
      setStarting(false);
    }
  };

  const repair = async () => {
    setAsking(true);
    setError(null);
    try {
      if (!(await onRepair(proposal)))
        setError("Could not ask the lead. Try again once its turn ends.");
    } finally {
      setAsking(false);
    }
  };

  const title = planning
    ? proposal.request
    : proposal.title || proposal.request || "Orchestration proposal";

  return (
    <article
      aria-label="Orchestration proposal"
      className="bg-card border-border overflow-hidden rounded-xl border"
    >
      <header className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
        <span className="bg-foreground/[0.06] text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
          <HugeiconsIcon
            icon={leadIcon(teamLead?.icon)}
            className="size-4"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-medium" title={title}>
            {title}
          </h2>
          <p className="text-muted-foreground mt-0.5 flex items-center gap-3 text-[11px]">
            {proposal.teamLead &&
              (teamLead || leadsRead ? (
                <span
                  className="text-foreground/80 min-w-0 truncate font-medium"
                  title={`Team lead @${proposal.teamLead}`}
                >
                  {teamLead?.name ?? `@${proposal.teamLead}`}
                </span>
              ) : (
                <TextSkeleton label="Reading the team lead" className="w-20" />
              ))}
            <span className="flex min-w-0 items-center gap-1.5">
              <TerminalKindIcon kind={leadAgent} className="size-3 shrink-0" />
              <span className="truncate">Led by {AGENT_LABELS[leadAgent]}</span>
            </span>
            {planning ? (
              <span className="shrink-0">Planning the tasks</span>
            ) : (
              tasks.length > 0 && (
                <span className="shrink-0 tabular-nums">
                  {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                </span>
              )
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {proposal.status === "invalid" &&
            !cancelled &&
            !proposal.repaired && (
              <Button
                size="sm"
                variant="outline"
                disabled={asking}
                onClick={() => void repair()}
              >
                {asking ? "Asking…" : "Ask to fix"}
              </Button>
            )}
          {!approved && !cancelled && !planning && (
            <Button
              size="sm"
              variant="ghost"
              disabled={starting}
              onClick={() => patch(proposal.id, { cancelled: true })}
            >
              Cancel
            </Button>
          )}
          {proposal.status === "ready" && !approved && !cancelled && (
            <Button
              size="sm"
              disabled={!editable}
              onClick={() => void approve()}
            >
              <HugeiconsIcon
                icon={PlayIcon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden="true"
              />
              {starting ? "Starting…" : "Approve"}
            </Button>
          )}
          {cancelled && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => patch(proposal.id, { cancelled: false })}
            >
              Undo cancel
            </Button>
          )}
        </div>
      </header>

      {planning && (
        <ListSkeleton
          label="Planning the tasks"
          rows={3}
          className="border-border border-t"
        />
      )}

      {!planning && proposal.summary && !cancelled && (
        <p className="text-muted-foreground border-border border-t px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap">
          {proposal.summary}
        </p>
      )}

      {!planning && !cancelled && tasks.length > 0 && (
        <ul className="border-border border-t py-1">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              index={tasks.indexOf(task)}
              tasks={tasks}
              teamLead={teamLead}
              editable={editable}
              onChange={(next) => change(task.id, next)}
            />
          ))}
        </ul>
      )}
      {!planning && !cancelled && tasks.length > FOLDED && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          className="text-muted-foreground hover:text-foreground border-border flex h-8 w-full items-center gap-1.5 border-t px-3 text-left text-[11px]"
        >
          <HugeiconsIcon
            icon={showAll ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5"
            strokeWidth={2}
            aria-hidden="true"
          />
          {showAll ? "Show fewer tasks" : `Show ${tasks.length - FOLDED} more`}
        </button>
      )}

      {(error || (proposal.status === "invalid" && !cancelled)) && (
        <div
          role="alert"
          className="text-destructive border-border flex items-start gap-2 border-t px-3 py-2 text-[12px]"
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            className="mt-0.5 size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 break-words">
            {error ??
              `Could not read the lead's proposal: ${proposal.error ?? "it is invalid."}${proposal.repaired ? " The lead was already asked to fix it once; send /orchestrate again to start over." : ""}`}
          </span>
        </div>
      )}

      {!planning && !cancelled && proposal.status === "ready" && (
        <footer className="text-muted-foreground border-border flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span id={`workers-${proposal.id}`}>Parallel workers</span>
            <div
              role="radiogroup"
              aria-labelledby={`workers-${proposal.id}`}
              className="bg-foreground/[0.05] flex items-center gap-0.5 rounded-md p-0.5"
            >
              {Array.from({ length: workersCap }, (_, at) => at + 1).map(
                (count) => (
                  // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a column of radio inputs.
                  <button
                    key={count}
                    type="button"
                    role="radio"
                    aria-checked={maxWorkers === count}
                    disabled={!editable}
                    onClick={() => patch(proposal.id, { maxWorkers: count })}
                    className={cn(
                      "grid size-5 place-items-center rounded-[5px] tabular-nums",
                      maxWorkers === count
                        ? "bg-background text-foreground font-medium shadow-xs"
                        : "hover:text-foreground",
                    )}
                  >
                    {count}
                  </button>
                ),
              )}
            </div>
          </div>
          <span>
            {approved
              ? "Approved"
              : "Nothing runs until you approve, and each worker gets its own checkout."}
          </span>
        </footer>
      )}

      {cancelled && (
        <p className="text-muted-foreground border-border border-t px-3 py-2 text-[12px]">
          Cancelled. No worker was started.
        </p>
      )}
    </article>
  );
}
