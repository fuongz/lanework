import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  HelpCircleIcon,
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
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { ModelMenu } from "#/components/shared/conversation/composer.menus";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import { taskWaves } from "#/components/shared/orchestration/run-steps";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
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
  toggled,
  onToggle,
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
  /** Opened by the user. Held by the card: a new dependency moves the row to
   * another step, which mounts it anew. */
  toggled: boolean;
  onToggle: (open: boolean) => void;
}) {
  const setToggled = onToggle;
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
  const writes = task.files.includes(".")
    ? "Writes anywhere"
    : task.files.length === 0
      ? "Read only"
      : task.files.length === 1
        ? `Writes ${task.files[0]}`
        : `Writes ${task.files.length} paths`;
  const after = task.dependsOn
    .map((dep) => tasks.findIndex((other) => other.id === dep) + 1)
    .filter((at) => at > 0)
    .sort((x, y) => x - y);
  // Two lines, as a lesson list reads: the task, then what it is in muted
  // words set apart by space. The number in a soft circle; the row lifts on
  // hover and stays lifted while open.
  return (
    <li id={`${base}-${task.id}-row`} className="flex flex-col">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-150",
          open ? "bg-muted/70" : "hover:bg-muted/50",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Details for ${index + 1}. ${task.title}${invalid ? ", needs a fix" : ""}`}
          // Not closed while it holds an error.
          onClick={() => setToggled(invalid ? true : !open)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
        >
          <span
            aria-hidden="true"
            className={cn(
              // The height of the two lines beside it.
              "grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-medium tabular-nums",
              invalid
                ? "bg-destructive/10 text-destructive"
                : "bg-background text-muted-foreground ring-border ring-1",
            )}
          >
            {invalid ? "!" : index + 1}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className="text-foreground truncate text-[13px] leading-snug font-semibold"
              title={task.title}
            >
              {task.title}
            </span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-2.5 text-[11.5px] leading-snug">
              <span className="shrink-0 font-mono text-[11px]">{task.id}</span>
              <span
                className={cn(
                  "truncate",
                  // Writing nothing is worth seeing at a glance.
                  task.files.length === 0 && "text-tone-teal",
                )}
                title={task.files.join(", ")}
              >
                {writes}
              </span>
              {after.length > 0 && (
                <span className="shrink-0">After {after.join(", ")}</span>
              )}
            </span>
          </span>
        </button>
        {/* The composer's own model pill (FE-95): model and effort in one,
            with Auto when the run may pick by tier. */}
        <ModelMenu
          side="bottom"
          fast={false}
          disabled={!editable}
          className="border-border text-muted-foreground bg-background h-7 shrink-0 rounded-full border px-2.5 text-[11.5px]"
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
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setToggled(invalid ? true : !open)}
          className="text-muted-foreground/70 hover:text-foreground grid size-5 shrink-0 place-items-center"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className={cn(
              "size-3 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </button>
      </div>
      {missing && task.model && (
        <p
          id={warning}
          className="text-muted-foreground flex items-start gap-1.5 pt-1 pr-2 pb-1.5 pl-14 text-[11px]"
        >
          {/* Said, not blocked: Approve still tries it; main has the last word. */}
          {modelName(task.model) ?? task.model} is not in{" "}
          {AGENT_LABELS[task.agent ?? "claude"]}'s model list. Pick another to
          be safe, or approve to try it as it is.
        </p>
      )}
      {open && (
        // Lined up with the title, under the lifted row.
        <div className="mt-2 mr-2 mb-3 ml-14 flex min-w-0 flex-col gap-2.5">
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
                      data-dep-chip={`${base}-${task.id}-${other.id}`}
                      onClick={() => {
                        onChange({
                          dependsOn: on
                            ? task.dependsOn.filter(
                                (entry) => entry !== other.id,
                              )
                            : [...task.dependsOn, other.id],
                        });
                        // The row may move to another step and mount anew:
                        // the focus follows it to the same chip.
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLElement>(
                              `[data-dep-chip="${base}-${task.id}-${other.id}"]`,
                            )
                            ?.focus(),
                        );
                      }}
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

/**
 * Whether a line-clamped paragraph hides some of its text, measured, not
 * guessed from its length: kept current as the card is resized. While it is
 * open, the answer from when it was clamped stands.
 */
function useClamped(
  ref: { current: HTMLElement | null },
  open: boolean,
  text: string,
): boolean {
  const [cut, setCut] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the text changes.
  useEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () =>
      setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, open, text]);
  return cut;
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
      className={cn(
        "bg-muted flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px]",
        tone,
      )}
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
  project,
  lead,
  leadAgent,
  proposal,
  teamLead,
  leadsRead,
  runMissing = false,
  onRepair,
  onApproved,
}: {
  project: string;
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
  /** The task rows the user opened, by id. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
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
  // The tasks in dependency waves, as the run will start them; folded, only
  // the first FOLDED tasks show, each still under its own step.
  const waves = taskWaves(tasks);
  const shownWaves = waves
    .map((wave, at) => ({
      step: at + 1,
      tasks: wave.filter((task) => visible.includes(task)),
    }))
    .filter((wave) => wave.tasks.length > 0);
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
      project,
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
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const summaryCut = useClamped(summaryRef, summaryOpen, proposal.summary);
  // Approved, its run gone: only that is said, not the tasks it ran.
  const gone = approved && runMissing;

  return (
    <article
      aria-label="Orchestration proposal"
      // The run panel's soft lift, so the card and the run it becomes match.
      // The muted shell shows only below the card: the footer sits on it as
      // an ear, the way a composer's agent strip sits on top of its field.
      className="bg-muted/60 border-border overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-8px_rgb(0_0_0/0.12)]"
    >
      <div className="bg-card border-border -m-px overflow-hidden rounded-2xl border">
        <header className="flex min-w-0 items-start gap-3 px-4 pt-3.5 pb-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* A small caps eyebrow: who proposes, and how much. */}
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px] font-medium tracking-[0.06em] uppercase">
              {planning ? (
                // Still planning: the app's working mark, in the conductor's
                // violet, where its icon will be; no word for it.
                <OrbitSpinner className="text-tone-violet size-3 gap-px p-0" />
              ) : (
                <HugeiconsIcon
                  icon={leadIcon(teamLead?.icon)}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="text-tone-violet size-3 shrink-0"
                />
              )}
              {proposal.teamLead ? (
                teamLead || leadsRead ? (
                  <span
                    className="truncate"
                    title={`Conductor @${proposal.teamLead}`}
                  >
                    {teamLead?.name ?? `@${proposal.teamLead}`}
                  </span>
                ) : (
                  <TextSkeleton
                    label="Reading the conductor"
                    className="w-20"
                  />
                )
              ) : (
                <span>Proposal</span>
              )}
              {!planning && tasks.length > 0 && (
                <span className="text-muted-foreground/70 shrink-0 tabular-nums normal-case tracking-normal">
                  {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                  {waves.length > 1 ? `, ${waves.length} steps` : ""}
                </span>
              )}
            </p>
            <h2
              ref={headingRef}
              // Not in the tab order: the focus is only moved here, after a
              // cancel is undone or an approval leaves no run to show.
              tabIndex={-1}
              className="focus-visible:ring-ring/30 line-clamp-2 rounded-sm text-[15px] leading-snug font-medium text-balance outline-none focus-visible:ring-2"
              title={title}
            >
              {title}
              {planning && <span className="sr-only">, planning</span>}
            </h2>
          </div>
          {!planning && (
            <ProposalStatus
              planning={planning}
              approved={approved}
              cancelled={cancelled}
              invalid={proposal.status === "invalid"}
            />
          )}
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
                It was approved, but the app no longer has it: it was removed,
                or its data was cleared. Send /orchestrate again to plan a new
                run.
              </span>
            </p>
          </div>
        )}

        {!planning && !gone && proposal.summary && !cancelled && (
          <div className="px-4 pb-3">
            <p
              ref={summaryRef}
              className={cn(
                "text-muted-foreground text-[12.5px] leading-relaxed whitespace-pre-wrap",
                !summaryOpen && "line-clamp-2",
              )}
            >
              {proposal.summary}
            </p>
            {/* Only when the two lines actually cut it short. */}
            {(summaryCut || summaryOpen) && (
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
          <div className="px-2 pb-2">
            {shownWaves.map(({ step, tasks: wave }, index) => {
              const stepId = `${base}-step-${step}`;
              const stepped = waves.length > 1;
              return (
                // Steps as the run panel draws them: a hairline between.
                <section
                  key={stepId}
                  aria-labelledby={stepped ? stepId : undefined}
                  className={cn(
                    index > 0 && "border-border mt-1 border-t pt-1",
                  )}
                >
                  {stepped && (
                    // A step heads its tasks as a module heads its lessons:
                    // its name, then a soft badge with how many.
                    <h3
                      id={stepId}
                      className="flex items-center gap-2 px-2 pt-2 pb-1 text-[13px] font-medium"
                    >
                      Step {step}
                      <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-px text-[11px] font-normal tabular-nums">
                        {waves[step - 1]?.length ?? 0}{" "}
                        {(waves[step - 1]?.length ?? 0) === 1
                          ? "task"
                          : "tasks"}
                      </span>
                    </h3>
                  )}
                  <ul aria-label={stepped ? `Tasks, step ${step}` : "Tasks"}>
                    {wave.map((task) => (
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
                        toggled={opened.has(task.id)}
                        onToggle={(next) =>
                          setOpened((before) => {
                            const after = new Set(before);
                            if (next) after.add(task.id);
                            else after.delete(task.id);
                            return after;
                          })
                        }
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        {!planning && !gone && !cancelled && tasks.length > FOLDED && (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
            className={cn(
              "text-muted-foreground hover:text-foreground -mt-1 flex h-8 w-full items-center gap-1.5 px-4 pb-1 text-left text-[11px]",
              line,
            )}
          >
            <HugeiconsIcon
              icon={showAll ? ArrowDown01Icon : ArrowRight01Icon}
              className="size-3.5"
              strokeWidth={2}
              aria-hidden="true"
            />
            {showAll
              ? "Show fewer tasks"
              : `Show ${tasks.length - FOLDED} more`}
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
      </div>

      {!planning && !gone && !cancelled && proposal.status === "ready" && (
        <footer
          className={cn(
            "text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-2 pb-2 text-[11px]",
            line,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center">
            {approved ? (
              <span className="truncate">Approved</span>
            ) : (
              // What approving does, kept off the ear until asked.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="What happens when you approve"
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 -ml-1 grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2"
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={HelpCircleIcon}
                    strokeWidth={1.8}
                    className="size-4"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipContent>
                  Nothing runs until you approve. Each worker gets its own
                  checkout.
                </TooltipContent>
              </Tooltip>
            )}
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
              {/* The answer the card waits for: full-size, wider buttons. */}
              <Button
                size="lg"
                variant="secondary"
                disabled={starting}
                onClick={cancel}
                className="h-8 min-w-20 px-4 text-[13px]"
              >
                Cancel
              </Button>
              <Button
                size="lg"
                disabled={!editable}
                className="h-8 min-w-28 gap-1.5 px-5 text-[13px] has-data-[icon=inline-start]:pl-4"
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
            // An ear under the card, as the footer is.
            "text-muted-foreground px-4 py-2 text-[12px]",
            line,
          )}
        >
          Cancelled. No worker was started.
        </p>
      )}
    </article>
  );
}
