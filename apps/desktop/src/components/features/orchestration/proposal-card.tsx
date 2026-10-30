import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState } from "react";
import {
  AGENT_LABELS,
  agentOfModel,
  type ConversationAgent,
  DEFAULT_SETTINGS,
  modelName,
} from "#/../shared/conversation";
import {
  FILES_MAX,
  JUDGE_POINTS,
  type JudgePoint,
  type OrchestrationProposal,
  type OrchestrationRun,
  PROMPT_MAX,
  type ProposedTask,
  parseProposal,
  REPO_LEAD_PREFIX,
  scopePath,
  type TeamLead,
  TITLE_MAX,
  WORKERS_MAX,
} from "#/../shared/orchestration";
import { ModelMenu } from "#/components/shared/conversation/composer.menus";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { ipcMessage } from "#/lib/ipc-error";
import {
  catalog,
  DEFAULT_MAX_WORKERS,
  type DerivedProposal,
  LEAD_SOURCE_LABELS,
  leadIcon,
  tiersAllowed,
} from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { useProposalEdits } from "./orchestration-panel.store";

const POINT_LABELS: Record<JudgePoint, string> = {
  "model-tier": "Model tier",
  permission: "Permissions",
  report: "Worker reports",
};

/**
 * What the team lead brings to the run, before the user approves it
 * (FE-89/D5): where it comes from, every Jev point it overrides, and the
 * checks each worker is told to run.
 */
function TeamLeadTerms({
  lead,
  className,
}: {
  lead: TeamLead;
  className: string;
}) {
  const overrides = JUDGE_POINTS.flatMap((point) => {
    const config = lead.jev?.[point];
    return config ? [{ point, ...config }] : [];
  });
  const term = "text-muted-foreground w-28 shrink-0";
  // Only what changes how the run behaves: a personal conductor with no
  // overrides and no checks has nothing to say here.
  if (lead.source !== "repo" && !overrides.length && !lead.checks.length)
    return null;
  return (
    <dl
      aria-label="Conductor terms"
      className={cn(
        "flex flex-col gap-1.5 border-t px-3 py-2 text-[12px]",
        className,
      )}
    >
      {lead.source === "repo" && (
        <div className="flex min-w-0 gap-2">
          <dt className={term}>Conductor from</dt>
          <dd className="min-w-0 break-words">
            {LEAD_SOURCE_LABELS[lead.source]}
            {lead.source === "repo" && (
              <span className="text-muted-foreground font-mono">
                {" "}
                .lanework/leads/{lead.id.slice(REPO_LEAD_PREFIX.length)}.md
              </span>
            )}
          </dd>
        </div>
      )}
      {overrides.length > 0 && (
        <div className="flex min-w-0 gap-2">
          <dt className={term}>Judge overrides</dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            {overrides.map((entry) => (
              <span
                key={entry.point}
                className={cn(entry.mode === "enforce" && "text-foreground")}
              >
                {POINT_LABELS[entry.point]}:{" "}
                {entry.mode === "enforce"
                  ? `acts on its own at ${Math.round(entry.threshold * 100)}% sure or more`
                  : "shadow, never acts"}
              </span>
            ))}
          </dd>
        </div>
      )}
      {lead.checks.length > 0 && (
        <div className="flex min-w-0 gap-2">
          <dt className={term}>Checks to report</dt>
          <dd className="min-w-0">
            <ul className="flex flex-col gap-0.5">
              {lead.checks.map((check) => (
                <li key={check} className="break-words">
                  {check}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The model select's value for a task left to its tier. */
const AUTO = "auto";
/** The effort select's value for the model's own default. */
const _DEFAULT_EFFORT = "default";
/** Tasks drawn before "Show more". */
const FOLDED = 4;

function _modelValue(task: ProposedTask): string {
  return task.model ? `${task.agent ?? "claude"}:${task.model}` : AUTO;
}

/** "src/a, src/b" → its paths; blank entries dropped. */
function splitScopes(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The fields of a task the card checks before Approve. */
type Field = "title" | "prompt" | "files" | "dependsOn";
/** What is wrong with each task, by task id, then by field. */
type FieldErrors = Record<string, Partial<Record<Field, string>>>;

/** The DOM id of a task's field, so its error and the focus can find it. */
function fieldId(base: string, task: string, field: Field): string {
  return `${base}-${task}-${field}`;
}

/** Whether following `from`'s dependencies leads back to `target`. */
function reaches(
  byId: Map<string, ProposedTask>,
  from: string,
  target: string,
  seen: Set<string>,
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (byId.get(from)?.dependsOn ?? []).some((next) =>
    reaches(byId, next, target, seen),
  );
}

/**
 * The same checks main runs on approval, said per field (FE-91): a blank
 * title, an absolute scope, a loop in "Starts after". Empty scopes are a
 * read-only task, not an error.
 */
function checkTasks(tasks: ProposedTask[]): FieldErrors {
  const errors: FieldErrors = {};
  const put = (task: string, field: Field, message: string) => {
    const entry = errors[task] ?? {};
    entry[field] ??= message;
    errors[task] = entry;
  };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const title = task.title.trim();
    if (!title) put(task.id, "title", "Give the task a title.");
    else if (title.length > TITLE_MAX)
      put(task.id, "title", `Keep the title to ${TITLE_MAX} characters.`);
    const prompt = task.prompt.trim();
    if (!prompt) put(task.id, "prompt", "Write the worker's instructions.");
    else if (prompt.length > PROMPT_MAX)
      put(
        task.id,
        "prompt",
        `Keep the instructions to ${PROMPT_MAX.toLocaleString()} characters.`,
      );
    if (task.files.length > FILES_MAX)
      put(task.id, "files", `List at most ${FILES_MAX} write scopes.`);
    for (const entry of task.files) {
      try {
        scopePath(entry, "Write scope");
      } catch (caught) {
        put(
          task.id,
          "files",
          caught instanceof Error ? caught.message : String(caught),
        );
        break;
      }
    }
    if (task.dependsOn.some((next) => reaches(byId, next, task.id, new Set())))
      put(
        task.id,
        "dependsOn",
        "These tasks wait on each other in a loop. Remove one of the links.",
      );
  }
  return errors;
}

/** A field's error line, read with the field through `aria-describedby`. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-destructive mt-1 text-[11px]">
      {message}
    </p>
  );
}

/**
 * A worker's model: one of the catalog's, or its tier's.
 *
 * Under a team lead, only its workers, and "Auto" only when they carry a
 * tier (FE-88).
 */
/**
 * Whether a task's model is one the picker offers. Codex's list comes from
 * the CLI and changes under it; a model it no longer lists is drawn as a
 * warning, not a dead end (FE-91).
 */
function unlisted(task: ProposedTask, teamLead: TeamLead | null): boolean {
  if (!task.model) return false;
  const agent = task.agent ?? "claude";
  return !catalog(teamLead).some(
    (entry) => entry.model === task.model && entry.agent === agent,
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
  error,
  onChange,
}: {
  id: string;
  task: ProposedTask;
  disabled: boolean;
  /** Its error line's id, when the scopes are refused. */
  error?: string;
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
      aria-invalid={error ? true : undefined}
      aria-describedby={error}
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
  base,
  task,
  index,
  tasks,
  teamLead,
  editable,
  errors,
  onChange,
}: {
  /** The card's id prefix for its fields. */
  base: string;
  task: ProposedTask;
  index: number;
  tasks: ProposedTask[];
  teamLead: TeamLead | null;
  editable: boolean;
  /** Its fields' errors, once Approve was tried. */
  errors: Partial<Record<Field, string>> | undefined;
  onChange: (patch: Partial<ProposedTask>) => void;
}) {
  const [toggled, setToggled] = useState(false);
  const invalid = Boolean(errors && Object.keys(errors).length);
  // A row with an error stays open: its field is where the error is said.
  const open = toggled || invalid;
  const id = (field: Field) => fieldId(base, task.id, field);
  const errorId = (field: Field) =>
    errors?.[field] ? `${id(field)}-error` : undefined;
  const warning = `${base}-${task.id}-model-warning`;
  const missing = unlisted(task, teamLead);
  const others = tasks.filter((entry) => entry.id !== task.id);
  const firstOn =
    others.find((other) => task.dependsOn.includes(other.id))?.id ??
    others[0]?.id;
  const label = "text-muted-foreground mb-1 block text-[11px]";
  return (
    <li className="flex flex-col">
      <div className="hover:bg-foreground/[0.02] flex min-h-8 min-w-0 items-center gap-1 px-2 py-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Details for ${task.title}${invalid ? ", needs a fix" : ""}`}
          // Not closed while it holds an error.
          onClick={() => setToggled(invalid ? true : !open)}
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
          <span className="truncate text-[12px]" title={task.title}>
            {task.title}
          </span>
          {invalid && (
            <HugeiconsIcon
              icon={Alert02Icon}
              className="text-destructive size-3.5 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          )}
        </button>
        {/* The composer's own model pill (FE-95): model and effort in one,
            with Auto when the run may pick by tier. */}
        <ModelMenu
          side="bottom"
          fast={false}
          disabled={!editable}
          className="h-7 shrink-0 text-xs"
          settings={{
            ...DEFAULT_SETTINGS,
            model: task.model ?? DEFAULT_SETTINGS.model,
            effort: task.effort ?? DEFAULT_SETTINGS.effort,
          }}
          effortSet={task.effort !== null}
          auto={
            tiersAllowed(teamLead)
              ? {
                  active: !task.model,
                  onPick: () => onChange({ agent: null, model: null }),
                }
              : undefined
          }
          onChange={(next) =>
            onChange({
              ...(next.model
                ? { model: next.model, agent: agentOfModel(next.model) }
                : {}),
              ...(next.effort ? { effort: next.effort } : {}),
            })
          }
        />
      </div>
      {missing && task.model && (
        <p
          id={warning}
          className="text-muted-foreground flex items-start gap-1.5 px-3 pb-1.5 pl-9 text-[11px]"
        >
          {/* Said, not blocked: Approve still tries it; main has the last word. */}
          {modelName(task.model) ?? task.model} is not in{" "}
          {AGENT_LABELS[task.agent ?? "claude"]}'s model list. Pick another to
          be safe, or approve to try it as it is.
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3 pl-9">
          <div>
            <label htmlFor={id("title")} className={label}>
              Task
            </label>
            <Input
              id={id("title")}
              value={task.title}
              disabled={!editable}
              aria-invalid={errors?.title ? true : undefined}
              aria-describedby={errorId("title")}
              onChange={(event) => onChange({ title: event.target.value })}
            />
            <FieldError id={`${id("title")}-error`} message={errors?.title} />
          </div>
          <div>
            <label htmlFor={id("prompt")} className={label}>
              Instructions
            </label>
            <Textarea
              id={id("prompt")}
              value={task.prompt}
              disabled={!editable}
              aria-invalid={errors?.prompt ? true : undefined}
              aria-describedby={errorId("prompt")}
              onChange={(event) => onChange({ prompt: event.target.value })}
              className="max-h-60"
            />
            <FieldError id={`${id("prompt")}-error`} message={errors?.prompt} />
          </div>
          <div>
            <label htmlFor={id("files")} className={label}>
              Write scopes
            </label>
            <ScopeField
              id={id("files")}
              task={task}
              disabled={!editable}
              error={errorId("files")}
              onChange={(files) => onChange({ files })}
            />
            <FieldError id={`${id("files")}-error`} message={errors?.files} />
          </div>
          {others.length > 0 && (
            <fieldset
              className="flex flex-col"
              aria-describedby={errorId("dependsOn")}
            >
              <legend className={label}>Starts after</legend>
              <div className="flex flex-wrap gap-1.5">
                {others.map((other) => {
                  const on = task.dependsOn.includes(other.id);
                  return (
                    <button
                      key={other.id}
                      // The first chip it waits on takes the focus for a
                      // loop's error.
                      id={other.id === firstOn ? id("dependsOn") : undefined}
                      type="button"
                      aria-pressed={on}
                      aria-invalid={errors?.dependsOn && on ? true : undefined}
                      aria-describedby={on ? errorId("dependsOn") : undefined}
                      title={`${tasks.indexOf(other) + 1}. ${other.title}`}
                      disabled={!editable}
                      onClick={() =>
                        onChange({
                          dependsOn: on
                            ? task.dependsOn.filter(
                                (entry) => entry !== other.id,
                              )
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
              <FieldError
                id={`${id("dependsOn")}-error`}
                message={errors?.dependsOn}
              />
            </fieldset>
          )}
        </div>
      )}
    </li>
  );
}

/** Where the proposal stands, as one small badge. */
function ProposalStatus({
  planning,
  approved,
  cancelled,
  invalid,
}: {
  planning: boolean;
  approved: boolean;
  cancelled: boolean;
  invalid: boolean;
}) {
  const [label, tone] = planning
    ? ["Planning", "text-muted-foreground text-shimmer"]
    : approved
      ? ["Approved", "text-tone-emerald"]
      : cancelled
        ? ["Cancelled", "text-muted-foreground"]
        : invalid
          ? ["Needs a fix", "text-destructive"]
          : ["Waiting for you", "text-tone-violet"];
  const waiting = !planning && !approved && !cancelled && !invalid;
  return (
    <span
      className={cn("flex items-center gap-1.5 text-[11px] font-medium", tone)}
    >
      {waiting && (
        <span
          aria-hidden="true"
          className="bg-tone-violet size-1.5 animate-pulse rounded-full motion-reduce:animate-none"
        />
      )}
      {label}
    </span>
  );
}

/**
 * The lead's proposal (FE-87): the tasks it would hand to workers, editable,
 * and nothing runs until Approve.
 *
 * Under a team lead (FE-88) it wears the lead's name and icon, offers only
 * its workers, and caps the parallel workers at its limit.
 *
 * The focus never falls to the page (FE-91): Cancel hands it to Undo cancel,
 * Undo cancel to the title, and Approve to the run panel that replaces the
 * card (or to the title, when the run is gone).
 */
export function ProposalCard({
  workspace,
  lead,
  leadAgent,
  proposal,
  teamLead,
  leadsRead,
  runMissing = false,
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
  /** Approved, but its run is no longer there (removed, or its data cleared). */
  runMissing?: boolean;
  /** Sends the one repair prompt; false when it could not be sent. */
  onRepair: (proposal: DerivedProposal) => Promise<boolean>;
  onApproved: (run: OrchestrationRun) => void;
}) {
  const edits = useProposalEdits((state) => state.edits[proposal.id]);
  const patch = useProposalEdits((state) => state.patch);
  const focusRequested = useProposalEdits(
    (state) => state.focus === proposal.id,
  );
  const setFocus = useProposalEdits((state) => state.setFocus);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Approve was tried: from then on each field says what is wrong with it.
  const [checked, setChecked] = useState(false);
  /** Where the focus goes after the next render: "heading", "undo", a DOM id. */
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const base = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);

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
  const errors = checked && editable ? checkTasks(tasks) : {};

  useEffect(() => {
    if (!focusNext) return;
    setFocusNext(null);
    const target =
      focusNext === "heading"
        ? headingRef.current
        : focusNext === "undo"
          ? undoRef.current
          : document.getElementById(focusNext);
    target?.focus();
  }, [focusNext]);

  // Approved, and still drawn here (its run is gone): the title takes the
  // focus the Approve button had.
  useEffect(() => {
    if (!focusRequested || !approved) return;
    setFocus(null);
    headingRef.current?.focus();
  }, [focusRequested, approved, setFocus]);

  const change = (id: string, next: Partial<ProposedTask>) => {
    setError(null);
    patch(proposal.id, {
      tasks: tasks.map((task) =>
        task.id === id ? { ...task, ...next } : task,
      ),
    });
  };

  const cancel = () => {
    patch(proposal.id, { cancelled: true });
    setFocusNext("undo");
  };

  const undoCancel = () => {
    patch(proposal.id, { cancelled: false });
    setFocusNext("heading");
  };

  const approve = async () => {
    const surface = window.desktop?.orchestration;
    if (!surface) return;
    setError(null);
    setChecked(true);
    // Each problem said on its field, and the focus taken to the first one.
    const found = checkTasks(tasks);
    const first = tasks.find((task) => found[task.id]);
    if (first) {
      const fields = found[first.id] ?? {};
      const field = (["title", "prompt", "files", "dependsOn"] as const).find(
        (key) => fields[key],
      );
      if (tasks.indexOf(first) >= FOLDED) setShowAll(true);
      if (field) setFocusNext(fieldId(base, first.id, field));
      const count = Object.values(found).reduce(
        (sum, entry) => sum + Object.keys(entry).length,
        0,
      );
      setError(
        count === 1
          ? "Fix the marked field to approve."
          : `Fix the ${count} marked fields to approve.`,
      );
      return;
    }
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
    let valid: OrchestrationProposal;
    try {
      // The same check main runs, for what the fields above do not cover.
      valid = parseProposal(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    setStarting(true);
    try {
      const run = await surface.approve(valid);
      // The run first, so the panel never draws the card as "run gone".
      onApproved(run);
      patch(proposal.id, { runId: run.id });
      setFocus(proposal.id);
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

  // Waiting on the user, it reads as an approval like a tool's (the
  // permission card's tint and buttons); once answered, a plain card.
  const _awaiting =
    !planning && proposal.status === "ready" && !approved && !cancelled;
  const line = "border-border";
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Approved, its run gone: only that is said, not the tasks it ran.
  const gone = approved && runMissing;

  return (
    <article
      aria-label="Orchestration proposal"
      className="bg-card border-border overflow-hidden rounded-xl border"
    >
      <header className="flex min-w-0 items-start gap-3 px-3 py-3">
        {/* The conductor's mark, in Orchestrate's violet: who proposes. */}
        <span className="bg-tone-violet/10 text-tone-violet grid size-8 shrink-0 place-items-center rounded-lg">
          <HugeiconsIcon
            icon={leadIcon(teamLead?.icon)}
            className="size-4"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px]">
            {proposal.teamLead ? (
              teamLead || leadsRead ? (
                <span
                  className="min-w-0 truncate"
                  title={`Conductor @${proposal.teamLead}`}
                >
                  <span className="text-foreground/80 font-medium">
                    {teamLead?.name ?? `@${proposal.teamLead}`}
                  </span>{" "}
                  proposes
                </span>
              ) : (
                <TextSkeleton label="Reading the conductor" className="w-20" />
              )
            ) : (
              <span>Proposal</span>
            )}
          </p>
          <h2
            ref={headingRef}
            // Not in the tab order: the focus is only moved here, after a
            // cancel is undone or an approval leaves no run to show.
            tabIndex={-1}
            className="focus-visible:ring-ring/30 mt-0.5 line-clamp-2 rounded-sm text-[14px] leading-snug font-medium text-balance outline-none focus-visible:ring-2"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <ProposalStatus
            planning={planning}
            approved={approved}
            cancelled={cancelled}
            invalid={proposal.status === "invalid"}
          />
          {!planning && tasks.length > 0 && (
            <span className="bg-foreground/[0.05] text-muted-foreground rounded-md px-1.5 py-0.5 text-[11px] tabular-nums">
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            </span>
          )}
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
          {/* Not ready to approve, yet still the user's to drop. */}
          {!approved &&
            !cancelled &&
            !planning &&
            proposal.status !== "ready" && (
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            )}
          {cancelled && (
            <Button
              ref={undoRef}
              size="sm"
              variant="ghost"
              onClick={undoCancel}
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
          className={cn("border-t", line)}
        />
      )}

      {gone && (
        <div
          className={cn(
            "flex items-start gap-2 border-t px-3 py-2 text-[12px]",
            line,
          )}
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            className="text-tone-amber mt-0.5 size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <p className="min-w-0">
            <span className="font-medium">This run no longer exists.</span>{" "}
            <span className="text-muted-foreground">
              It was approved, but the app no longer has it: it was removed, or
              its data was cleared. Send /orchestrate again to plan a new run.
            </span>
          </p>
        </div>
      )}

      {!planning && !gone && proposal.summary && !cancelled && (
        <div className={cn("border-t px-3 py-2", line)}>
          <p
            className={cn(
              "text-muted-foreground text-[12px] leading-relaxed whitespace-pre-wrap",
              !summaryOpen && "line-clamp-3",
            )}
          >
            {proposal.summary}
          </p>
          {proposal.summary.length > 240 && (
            <button
              type="button"
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen(!summaryOpen)}
              className="text-muted-foreground hover:text-foreground mt-1 text-[11px] font-medium"
            >
              {summaryOpen ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {!planning && !gone && !cancelled && teamLead && (
        <TeamLeadTerms lead={teamLead} className={line} />
      )}

      {!planning && !gone && !cancelled && tasks.length > 0 && (
        <ul className={cn("divide-border divide-y border-t", line)}>
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              base={base}
              task={task}
              index={tasks.indexOf(task)}
              tasks={tasks}
              teamLead={teamLead}
              editable={editable}
              errors={errors[task.id]}
              onChange={(next) => change(task.id, next)}
            />
          ))}
        </ul>
      )}
      {!planning && !gone && !cancelled && tasks.length > FOLDED && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          className={cn(
            "text-muted-foreground hover:text-foreground flex h-8 w-full items-center gap-1.5 border-t px-3 text-left text-[11px]",
            line,
          )}
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
          className={cn(
            "text-destructive flex items-start gap-2 border-t px-3 py-2 text-[12px]",
            line,
          )}
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

      {!planning && !gone && !cancelled && proposal.status === "ready" && (
        <footer
          className={cn(
            "text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 text-[11px]",
            line,
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {approved
              ? "Approved"
              : "Nothing runs until you approve. Each worker gets its own checkout."}
          </span>
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
          {!approved && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={starting}
                onClick={cancel}
              >
                Cancel
              </Button>
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
            </div>
          )}
        </footer>
      )}

      {cancelled && (
        <p
          className={cn(
            "text-muted-foreground border-t px-3 py-2 text-[12px]",
            line,
          )}
        >
          Cancelled. No worker was started.
        </p>
      )}
    </article>
  );
}
