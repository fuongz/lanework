import {
  ArrowDown01Icon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { effectiveKnobs } from "#/../shared/autonomy";
import {
  agentOfModel,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  settingsFor,
} from "#/../shared/conversation";
import {
  checkRoutineInput,
  isTimeZone,
  LOOP_MINUTES_MAX,
  LOOP_MINUTES_MIN,
  ROUTINE_DEFAULTS,
  ROUTINE_PRESETS,
  type Routine,
  type RoutineAgent,
  type RoutineInput,
  type RoutinePreset,
  type RoutineSchedule,
  type RoutineWorkspace,
} from "#/../shared/routines";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import {
  ModelMenu,
  PermissionMenu,
  PILL,
} from "#/components/shared/conversation/composer.menus";
import {
  isoToZoned,
  machineTimeZone,
  PRESET_LABELS,
  timeZones,
  WEEKDAY_LABELS,
  zonedToIso,
} from "#/components/shared/routines/routine-format";
import { RoutineTrust } from "#/components/shared/routines/routine-trust";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";
import { useProjectAutonomy } from "#/stores/autonomy";
import { useRoutines } from "#/stores/routines";

type ScheduleKind = RoutineSchedule["kind"];

const SCHEDULE_KINDS = [
  { value: "preset" as const, label: "Repeat" },
  { value: "cron" as const, label: "Cron" },
  { value: "once" as const, label: "Once" },
  { value: "loop" as const, label: "Loop" },
];

/** A new loop's pace when its agent says nothing (FE-172). */
const LOOP_DEFAULT_MINUTES = 60;

/** Where a run works, as the composer's pills read. */
const WORKSPACES: Record<
  RoutineWorkspace,
  { label: string; description: string; icon: typeof Folder01Icon }
> = {
  current: {
    label: "Project folder",
    description: "Works in this project's folder, as you do.",
    icon: Folder01Icon,
  },
  worktree: {
    label: "New worktree",
    description:
      "A fresh worktree per run. One the agent changed is kept for you to review.",
    icon: GitBranchIcon,
  },
};

/** A conversation's other CLI never runs a routine. */
const NOT_HEADLESS = ["opencode"] as const;

/** The form as typed: numbers stay text until Save reads them. */
interface Draft {
  /**
   * A routine's name as saved, kept while its prompt is: there is no
   * field for it, a name is the start of the prompt.
   */
  name: string;
  /** The prompt `name` was saved with. */
  namedPrompt: string;
  prompt: string;
  agent: RoutineAgent;
  settings: ComposerSettings;
  workspace: RoutineWorkspace;
  kind: ScheduleKind;
  preset: RoutinePreset;
  /** `HH:MM`, for every preset but hourly. */
  time: string;
  /** Minutes past the hour, for hourly. */
  minute: string;
  weekday: number;
  cron: string;
  /** A `datetime-local` value, read in `timezone`. */
  once: string;
  /** A loop's pace when its agent says nothing, in minutes. */
  loop: string;
  timezone: string;
  grace: string;
  timeout: string;
  enabled: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function blankDraft(): Draft {
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  return {
    name: "",
    namedPrompt: "",
    prompt: "",
    agent: "claude",
    settings: settingsFor("claude", DEFAULT_SETTINGS),
    workspace: "current",
    kind: "preset",
    preset: "daily",
    time: "09:00",
    minute: "0",
    weekday: 1,
    cron: "0 9 * * 1-5",
    once: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T09:00`,
    loop: String(LOOP_DEFAULT_MINUTES),
    timezone: machineTimeZone(),
    grace: String(ROUTINE_DEFAULTS.graceMinutes),
    timeout: String(ROUTINE_DEFAULTS.timeoutMinutes),
    enabled: true,
  };
}

function draftFrom(routine: Routine): Draft {
  const draft: Draft = {
    ...blankDraft(),
    name: routine.name,
    namedPrompt: routine.prompt,
    prompt: routine.prompt,
    agent: routine.agent,
    settings: routine.settings,
    workspace: routine.workspace,
    kind: routine.schedule.kind,
    timezone: routine.timezone,
    grace: String(routine.graceMinutes),
    timeout: String(routine.timeoutMinutes),
    enabled: routine.enabled,
  };
  const schedule = routine.schedule;
  if (schedule.kind === "cron") draft.cron = schedule.expr;
  if (schedule.kind === "loop") draft.loop = String(schedule.minutes);
  if (schedule.kind === "once")
    draft.once = isoToZoned(schedule.at, routine.timezone) || draft.once;
  if (schedule.kind === "preset") {
    draft.preset = schedule.preset;
    draft.minute = String(schedule.minute);
    draft.time = `${pad(schedule.hour ?? 9)}:${pad(schedule.minute)}`;
    draft.weekday = schedule.weekday ?? 1;
  }
  return draft;
}

/** How long a name taken from the prompt may be. */
const NAME_FROM_PROMPT_MAX = 60;

/**
 * A routine's name, from the start of its `prompt`: the first line
 * with words in it, cut at a word near {@link NAME_FROM_PROMPT_MAX}.
 */
function nameFromPrompt(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((text) => text.replace(/^(\s*([#>*-]+|\d+[.)])\s+)+/, "").trim())
      .find((text) => /[\p{L}\p{N}]/u.test(text)) ?? "";
  if (line.length <= NAME_FROM_PROMPT_MAX) return line;
  const cut = line.slice(0, NAME_FROM_PROMPT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:(-]+$/, "")}…`;
}

/** A whole number typed in `text`, or null. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** The schedule the draft describes, or why it does not. */
function readSchedule(draft: Draft): RoutineSchedule | string {
  if (draft.kind === "cron") {
    const expr = draft.cron.trim();
    return expr.split(/\s+/).length === 5
      ? { kind: "cron", expr }
      : "A cron expression has five fields: minute, hour, day, month and weekday.";
  }
  if (draft.kind === "loop") {
    const minutes = wholeNumber(draft.loop);
    return minutes !== null &&
      minutes >= LOOP_MINUTES_MIN &&
      minutes <= LOOP_MINUTES_MAX
      ? { kind: "loop", minutes }
      : `A loop runs every ${LOOP_MINUTES_MIN} to ${LOOP_MINUTES_MAX} minutes.`;
  }
  if (draft.kind === "once") {
    if (!isTimeZone(draft.timezone)) return "Pick a known time zone.";
    const at = zonedToIso(draft.once, draft.timezone);
    return at ? { kind: "once", at } : "Pick the date and time to run it.";
  }
  if (draft.preset === "hourly") {
    const minute = wholeNumber(draft.minute);
    return minute !== null && minute <= 59
      ? { kind: "preset", preset: "hourly", minute }
      : "Minutes past the hour go from 0 to 59.";
  }
  const match = /^(\d{1,2}):(\d{2})/.exec(draft.time);
  if (!match) return "Pick the time to run it.";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "Pick the time to run it.";
  return draft.preset === "weekly"
    ? { kind: "preset", preset: "weekly", hour, minute, weekday: draft.weekday }
    : { kind: "preset", preset: draft.preset, hour, minute };
}

/**
 * What Save sends, through the check main applies (`checkRoutineInput`),
 * or the first reason it cannot be sent.
 */
function readDraft(
  draft: Draft,
): { input: RoutineInput } | { problem: string } {
  if (!draft.prompt.trim()) return { problem: "Write the prompt it runs." };
  // NOTE: An edit that leaves the prompt alone keeps the name it had.
  const name =
    draft.name.trim() && draft.prompt === draft.namedPrompt
      ? draft.name
      : nameFromPrompt(draft.prompt);
  if (!name) return { problem: "Write the prompt it runs." };
  const schedule = readSchedule(draft);
  if (typeof schedule === "string") return { problem: schedule };
  if (!isTimeZone(draft.timezone))
    return { problem: "Pick a known time zone." };
  const grace = wholeNumber(draft.grace);
  if (grace === null || grace > 7 * 24 * 60)
    return { problem: "Grace is 0 to 10080 minutes." };
  const timeout = wholeNumber(draft.timeout);
  if (timeout === null || timeout < 1 || timeout > 24 * 60)
    return { problem: "Timeout is 1 to 1440 minutes." };
  const input = checkRoutineInput({
    name,
    prompt: draft.prompt,
    agent: draft.agent,
    settings: draft.settings,
    workspace: draft.workspace,
    schedule,
    timezone: draft.timezone,
    graceMinutes: grace,
    timeoutMinutes: timeout,
    enabled: draft.enabled,
  } satisfies RoutineInput);
  return input
    ? { input }
    : { problem: "Pick a model this agent offers, then save." };
}

/** A label above its field, for the fields too wide for a settings row. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** A small whole-number box with its unit after it. */
function MinutesInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <Input
        aria-label={label}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-20 text-right tabular-nums"
      />
      <span className="text-muted-foreground text-xs">min</span>
    </span>
  );
}

/**
 * When it runs: a preset, a cron expression, one date-time, or a loop its
 * agent paces.
 */
function ScheduleEditor({
  draft,
  update,
}: {
  draft: Draft;
  update: (change: Partial<Draft>) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-3.5 py-3">
      <SegmentedControl
        label="Schedule kind"
        value={draft.kind}
        options={SCHEDULE_KINDS}
        onChange={(kind) => update({ kind })}
        className="self-start"
      />
      {draft.kind === "preset" && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Repeats" htmlFor={`${id}-preset`}>
            <Select
              value={draft.preset}
              onValueChange={(value) =>
                update({ preset: value as RoutinePreset })
              }
            >
              <SelectTrigger id={`${id}-preset`} className="min-w-32">
                <SelectValue>
                  {(value: RoutinePreset) => PRESET_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ROUTINE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.preset === "weekly" && (
            <Field label="On" htmlFor={`${id}-weekday`}>
              <Select
                value={String(draft.weekday)}
                onValueChange={(value) => update({ weekday: Number(value) })}
              >
                <SelectTrigger id={`${id}-weekday`} className="min-w-32">
                  <SelectValue>
                    {(value: string) => WEEKDAY_LABELS[Number(value)]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAY_LABELS.map((label, day) => (
                    <SelectItem key={label} value={String(day)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {draft.preset === "hourly" ? (
            <Field label="Minutes past the hour" htmlFor={`${id}-minute`}>
              <Input
                id={`${id}-minute`}
                inputMode="numeric"
                value={draft.minute}
                onChange={(event) => update({ minute: event.target.value })}
                className="w-20 tabular-nums"
              />
            </Field>
          ) : (
            <Field label="At" htmlFor={`${id}-time`}>
              <Input
                id={`${id}-time`}
                type="time"
                value={draft.time}
                onChange={(event) => update({ time: event.target.value })}
                className="w-28 tabular-nums"
              />
            </Field>
          )}
        </div>
      )}
      {draft.kind === "cron" && (
        <Field
          label="Cron expression"
          hint="Five fields: minute, hour, day of month, month, day of week."
          htmlFor={`${id}-cron`}
        >
          <Input
            id={`${id}-cron`}
            value={draft.cron}
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            onChange={(event) => update({ cron: event.target.value })}
            className="font-mono"
          />
        </Field>
      )}
      {draft.kind === "once" && (
        <Field label="Run on" htmlFor={`${id}-once`}>
          <Input
            id={`${id}-once`}
            type="datetime-local"
            value={draft.once}
            onChange={(event) => update({ once: event.target.value })}
            className="w-56 tabular-nums"
          />
        </Field>
      )}
      {draft.kind === "loop" && (
        <Field
          label="Run again after"
          hint={`The agent sets its own pace: it names the next run with schedule_next, or ends the loop with schedule_stop. This is the wait when it says nothing (${LOOP_MINUTES_MIN} to ${LOOP_MINUTES_MAX} minutes).`}
          htmlFor={`${id}-loop`}
        >
          <span className="flex items-center gap-2">
            <Input
              id={`${id}-loop`}
              inputMode="numeric"
              value={draft.loop}
              onChange={(event) => update({ loop: event.target.value })}
              className="w-20 text-right tabular-nums"
            />
            <span className="text-muted-foreground text-xs">min</span>
          </span>
        </Field>
      )}
    </div>
  );
}

/**
 * New and Edit: one dialog. The prompt is written as in the chat's
 * composer, its model, permissions and workspace as pills under it. Save goes
 * through the check main applies, so what it sends is what main accepts.
 *
 * Mount it with a `key` per opening, so each one starts from its own draft.
 */
export function RoutineForm({
  routine,
  onClose,
  onSaved,
}: {
  /** The one to edit; absent for a new one. */
  routine?: Routine;
  onClose: () => void;
  onSaved: (routine: Routine) => void;
}) {
  const id = useId();
  const create = useRoutines((state) => state.create);
  const save = useRoutines((state) => state.update);
  const [draft, setDraft] = useState<Draft>(() =>
    routine ? draftFrom(routine) : blankDraft(),
  );
  // A new routine starts in the project's dial permission when it has
  // one (PD-08), until the menu is used. The dial may land after the open.
  const slug = useRoutines((state) => state.slug);
  const dial = useProjectAutonomy(routine ? null : slug);
  const [permissionPicked, setPermissionPicked] = useState(false);
  const dialPermission = dial ? effectiveKnobs(dial).permission : null;
  useEffect(() => {
    if (routine || permissionPicked || !dialPermission) return;
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, permission: dialPermission },
    }));
  }, [routine, permissionPicked, dialPermission]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(), []);
  const update = (change: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const read = readDraft(draft);
  const title = routine ? `Edit ${routine.name}` : "New routine";

  const submit = async () => {
    if (!("input" in read) || busy) return;
    setBusy(true);
    try {
      const saved = routine
        ? await save(routine.id, read.input)
        : await create(read.input);
      setError(null);
      onSaved(saved);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save the routine.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex h-[min(760px,88vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
            <SettingsPage
              title={title}
              description="An agent run on a schedule, each run a new conversation."
              searchable={false}
              compact
              sections={[
                {
                  title: "Task",
                  hideTitle: true,
                  content: (
                    <div className="flex flex-col gap-4">
                      <Field
                        label="Prompt"
                        hint="Sent as the first message of a new conversation on every run. Lanework adds one line: with nothing to report, the agent answers NOTHING_TO_REPORT and the run ends quietly."
                        htmlFor={`${id}-prompt`}
                      >
                        <PromptBox
                          id={`${id}-prompt`}
                          draft={draft}
                          update={update}
                          onPermission={() => setPermissionPicked(true)}
                        />
                      </Field>
                    </div>
                  ),
                },
                {
                  title: "Trust",
                  hideTitle: true,
                  content: <RoutineTrust slug={slug} agent={draft.agent} />,
                },
                {
                  title: "Schedule",
                  content: <ScheduleEditor draft={draft} update={update} />,
                },
                {
                  title: "Timing",
                  rows: [
                    {
                      label: "Time zone",
                      description: "The clock the schedule is read in.",
                      control: (
                        <>
                          <Input
                            aria-label="Time zone"
                            list={`${id}-zones`}
                            value={draft.timezone}
                            spellCheck={false}
                            aria-invalid={!isTimeZone(draft.timezone)}
                            onChange={(event) =>
                              update({ timezone: event.target.value })
                            }
                            className="w-52"
                          />
                          <datalist id={`${id}-zones`}>
                            {zones.map((zone) => (
                              <option key={zone} value={zone} />
                            ))}
                          </datalist>
                        </>
                      ),
                    },
                    {
                      label: "Grace",
                      description:
                        "How late a missed run may still start, say after the Mac slept.",
                      control: (
                        <MinutesInput
                          label="Grace in minutes"
                          value={draft.grace}
                          onChange={(grace) => update({ grace })}
                        />
                      ),
                    },
                    {
                      label: "Timeout",
                      description: "A run still going after this is stopped.",
                      control: (
                        <MinutesInput
                          label="Timeout in minutes"
                          value={draft.timeout}
                          onChange={(timeout) => update({ timeout })}
                        />
                      ),
                    },
                  ],
                },
              ]}
            />
          </div>
          <footer className="flex items-center justify-end gap-2 border-t px-5 py-2.5">
            <p
              role={error ? "alert" : undefined}
              className={cn(
                "mr-auto min-w-0 text-xs leading-snug",
                error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {error ?? ("problem" in read ? read.problem : null)}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !("input" in read)}
            >
              {busy ? "Saving…" : routine ? "Save" : "Create"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The prompt as the chat's composer writes one: the text, then its model
 * (any CLI's, which picks the agent), permissions and workspace as pills.
 */
function PromptBox({
  id,
  draft,
  update,
  onPermission,
}: {
  id: string;
  draft: Draft;
  update: (change: Partial<Draft>) => void;
  /** The person picked a permission: the project's dial no longer leads. */
  onPermission: () => void;
}) {
  return (
    <div className="border-input focus-within:border-ring/60 bg-background flex flex-col rounded-xl border transition-colors">
      <Textarea
        id={id}
        value={draft.prompt}
        maxLength={20_000}
        placeholder="Read the open issues and summarise what changed since yesterday."
        onChange={(event) => update({ prompt: event.target.value })}
        className="max-h-80 min-h-32 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 pb-1.5">
        <ModelMenu
          side="top"
          exclude={NOT_HEADLESS}
          settings={draft.settings}
          onChange={(next) => {
            const settings = { ...draft.settings, ...next };
            const agent = agentOfModel(settings.model);
            update({
              agent: agent === "codex" ? "codex" : "claude",
              settings,
            });
          }}
        />
        <PermissionMenu
          side="top"
          permission={draft.settings.permission}
          onChange={(permission) => {
            onPermission();
            update({ settings: { ...draft.settings, permission } });
          }}
        />
        <WorkspaceMenu
          workspace={draft.workspace}
          onChange={(workspace) => update({ workspace })}
        />
      </div>
    </div>
  );
}

/** Where a run works, as a pill beside the permission one. */
function WorkspaceMenu({
  workspace,
  onChange,
}: {
  workspace: RoutineWorkspace;
  onChange: (workspace: RoutineWorkspace) => void;
}) {
  const current = WORKSPACES[workspace];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Workspace: ${current.label}`}
        className={PILL}
      >
        <HugeiconsIcon
          icon={current.icon}
          className="size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span>{current.label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="text-muted-foreground size-3.5"
          strokeWidth={2}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="flex w-[22rem] flex-col gap-1 p-1.5"
      >
        {(["current", "worktree"] as const).map((entry) => (
          <DropdownMenuItem
            key={entry}
            onClick={() => onChange(entry)}
            className={cn(
              "items-start gap-3 rounded-lg px-3 py-2.5",
              entry === workspace && "bg-foreground/[0.08]",
            )}
          >
            <HugeiconsIcon
              icon={WORKSPACES[entry].icon}
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium">
                {WORKSPACES[entry].label}
              </span>
              <span className="text-muted-foreground text-xs leading-snug">
                {WORKSPACES[entry].description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
