import { type ReactNode, useId, useMemo, useState } from "react";
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_PRESETS,
  type Automation,
  type AutomationAgent,
  type AutomationInput,
  type AutomationPreset,
  type AutomationSchedule,
  type AutomationWorkspace,
  checkAutomationInput,
  isTimeZone,
} from "#/../shared/automations";
import {
  AGENT_LABELS,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  settingsFor,
} from "#/../shared/conversation";
import {
  isoToZoned,
  machineTimeZone,
  PRESET_LABELS,
  timeZones,
  WEEKDAY_LABELS,
  zonedToIso,
} from "#/components/shared/automations/automation-format";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import {
  ModelMenu,
  PermissionMenu,
} from "#/components/shared/conversation/composer.menus";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
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
import { useAutomations } from "#/stores/automations";

type ScheduleKind = AutomationSchedule["kind"];

const SCHEDULE_KINDS = [
  { value: "preset" as const, label: "Repeat" },
  { value: "cron" as const, label: "Cron" },
  { value: "once" as const, label: "Once" },
];

const AGENT_OPTIONS = [
  { value: "claude" as const, label: AGENT_LABELS.claude },
  { value: "codex" as const, label: AGENT_LABELS.codex },
];

const WORKSPACE_LABELS: Record<AutomationWorkspace, string> = {
  current: "Project folder",
  worktree: "New worktree",
};

/** A conversation's other CLI never runs an automation. */
const NOT_HEADLESS = ["opencode"] as const;

/** The form as typed: numbers stay text until Save reads them. */
interface Draft {
  name: string;
  prompt: string;
  agent: AutomationAgent;
  settings: ComposerSettings;
  workspace: AutomationWorkspace;
  kind: ScheduleKind;
  preset: AutomationPreset;
  /** `HH:MM`, for every preset but hourly. */
  time: string;
  /** Minutes past the hour, for hourly. */
  minute: string;
  weekday: number;
  cron: string;
  /** A `datetime-local` value, read in `timezone`. */
  once: string;
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
    timezone: machineTimeZone(),
    grace: String(AUTOMATION_DEFAULTS.graceMinutes),
    timeout: String(AUTOMATION_DEFAULTS.timeoutMinutes),
    enabled: true,
  };
}

function draftFrom(automation: Automation): Draft {
  const draft: Draft = {
    ...blankDraft(),
    name: automation.name,
    prompt: automation.prompt,
    agent: automation.agent,
    settings: automation.settings,
    workspace: automation.workspace,
    kind: automation.schedule.kind,
    timezone: automation.timezone,
    grace: String(automation.graceMinutes),
    timeout: String(automation.timeoutMinutes),
    enabled: automation.enabled,
  };
  const schedule = automation.schedule;
  if (schedule.kind === "cron") draft.cron = schedule.expr;
  if (schedule.kind === "once")
    draft.once = isoToZoned(schedule.at, automation.timezone) || draft.once;
  if (schedule.kind === "preset") {
    draft.preset = schedule.preset;
    draft.minute = String(schedule.minute);
    draft.time = `${pad(schedule.hour ?? 9)}:${pad(schedule.minute)}`;
    draft.weekday = schedule.weekday ?? 1;
  }
  return draft;
}

/** A whole number typed in `text`, or null. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** The schedule the draft describes, or why it does not. */
function readSchedule(draft: Draft): AutomationSchedule | string {
  if (draft.kind === "cron") {
    const expr = draft.cron.trim();
    return expr.split(/\s+/).length === 5
      ? { kind: "cron", expr }
      : "A cron expression has five fields: minute, hour, day, month and weekday.";
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
 * What Save sends, through the check main applies (`checkAutomationInput`),
 * or the first reason it cannot be sent.
 */
function readDraft(
  draft: Draft,
): { input: AutomationInput } | { problem: string } {
  if (!draft.name.trim()) return { problem: "Name it to save." };
  if (!draft.prompt.trim()) return { problem: "Write the prompt it runs." };
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
  const input = checkAutomationInput({
    name: draft.name,
    prompt: draft.prompt,
    agent: draft.agent,
    settings: draft.settings,
    workspace: draft.workspace,
    schedule,
    timezone: draft.timezone,
    graceMinutes: grace,
    timeoutMinutes: timeout,
    enabled: draft.enabled,
  } satisfies AutomationInput);
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

/** When it runs: a preset, a cron expression or one date-time. */
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
                update({ preset: value as AutomationPreset })
              }
            >
              <SelectTrigger id={`${id}-preset`} className="min-w-32">
                <SelectValue>
                  {(value: AutomationPreset) => PRESET_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_PRESETS.map((preset) => (
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
    </div>
  );
}

/**
 * New and Edit: one dialog, the conductor dialog's density. Save goes
 * through the check main applies, so what it sends is what main accepts.
 *
 * Mount it with a `key` per opening, so each one starts from its own draft.
 */
export function AutomationForm({
  automation,
  onClose,
  onSaved,
}: {
  /** The one to edit; absent for a new one. */
  automation?: Automation;
  onClose: () => void;
  onSaved: (automation: Automation) => void;
}) {
  const id = useId();
  const create = useAutomations((state) => state.create);
  const save = useAutomations((state) => state.update);
  const [draft, setDraft] = useState<Draft>(() =>
    automation ? draftFrom(automation) : blankDraft(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => timeZones(), []);
  const update = (change: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const read = readDraft(draft);
  const title = automation ? `Edit ${automation.name}` : "New automation";

  const submit = async () => {
    if (!("input" in read) || busy) return;
    setBusy(true);
    try {
      const saved = automation
        ? await save(automation.id, read.input)
        : await create(read.input);
      setError(null);
      onSaved(saved);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save the automation.",
      );
    } finally {
      setBusy(false);
    }
  };

  const task = (
    <div className="flex flex-col gap-4">
      <Field label="Name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={200}
          placeholder="Morning triage"
          onChange={(event) => update({ name: event.target.value })}
        />
      </Field>
      <Field
        label="Prompt"
        hint="Sent as the first message of a new conversation on every run. Lanework adds one line: with nothing to report, the agent answers NOTHING_TO_REPORT and the run ends quietly."
        htmlFor={`${id}-prompt`}
      >
        <Textarea
          id={`${id}-prompt`}
          value={draft.prompt}
          maxLength={20_000}
          placeholder="Read the open issues and summarise what changed since yesterday."
          onChange={(event) => update({ prompt: event.target.value })}
          className="max-h-64 min-h-24"
        />
      </Field>
    </div>
  );

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
                { title: "Task", hideTitle: true, content: task },
                {
                  title: "Agent",
                  rows: [
                    {
                      label: "Agent",
                      description: "The CLI that runs it.",
                      control: (
                        <SegmentedControl
                          label="Agent"
                          value={draft.agent}
                          options={AGENT_OPTIONS}
                          onChange={(agent) =>
                            update({
                              agent,
                              settings: settingsFor(agent, draft.settings),
                            })
                          }
                        />
                      ),
                    },
                    {
                      label: "Model",
                      description:
                        "What it thinks and replies with, and how hard.",
                      control: (
                        <ModelMenu
                          side="bottom"
                          agent={draft.agent}
                          exclude={NOT_HEADLESS}
                          settings={draft.settings}
                          onChange={(next) =>
                            update({
                              settings: { ...draft.settings, ...next },
                            })
                          }
                        />
                      ),
                    },
                    {
                      label: "Permissions",
                      description:
                        "What it may do without asking. Nobody is there to answer a run.",
                      control: (
                        <PermissionMenu
                          side="bottom"
                          permission={draft.settings.permission}
                          onChange={(permission) =>
                            update({
                              settings: { ...draft.settings, permission },
                            })
                          }
                        />
                      ),
                    },
                    {
                      label: "Workspace",
                      description:
                        "Where it works: this project's folder, or a fresh worktree. A worktree the agent changed is kept for you to review.",
                      control: (
                        <Select
                          value={draft.workspace}
                          onValueChange={(value) =>
                            update({ workspace: value as AutomationWorkspace })
                          }
                        >
                          <SelectTrigger
                            aria-label="Workspace"
                            className="min-w-36"
                          >
                            <SelectValue>
                              {(value: AutomationWorkspace) =>
                                WORKSPACE_LABELS[value]
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(["current", "worktree"] as const).map((value) => (
                              <SelectItem key={value} value={value}>
                                {WORKSPACE_LABELS[value]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ),
                    },
                  ],
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
              {busy ? "Saving…" : automation ? "Save" : "Create"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
