import {
  Add01Icon,
  AiChipIcon,
  Brain02Icon,
  Cancel01Icon,
  FlashIcon,
  Flowchart01Icon,
  Idea01Icon,
  Layers01Icon,
  MagicWand01Icon,
  Robot02Icon,
  Shield01Icon,
  SparklesIcon,
  Target02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
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
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { ipcMessage } from "#/lib/ipc-error";
import { useSettingsProject } from "#/stores/settings-project";
import {
  type AgentModel,
  allModels,
  EFFORT_LABELS,
  EFFORTS,
  type Effort,
  modelName,
} from "../../../../shared/conversation";
import {
  JUDGE_POINTS,
  type JudgeMode,
  type JudgePoint,
  LEAD_ICONS,
  LEAD_ID_PATTERN,
  LEAD_WORKERS_MAX,
  type LeadIcon,
  type LeadSource,
  type LeadsList,
  parseTeamLead,
  type TeamLead,
  type TeamLeadInput,
  TIERS,
  type Tier,
  WORKERS_MAX,
} from "../../../../shared/orchestration";

const ICONS: Record<LeadIcon, typeof Robot02Icon> = {
  Robot02Icon,
  Brain02Icon,
  Flowchart01Icon,
  Target02Icon,
  Shield01Icon,
  MagicWand01Icon,
  SparklesIcon,
  Wrench01Icon,
  Layers01Icon,
  Idea01Icon,
  FlashIcon,
  AiChipIcon,
};

/** `Robot02Icon` → `Robot`: the name a person reads in the icon picker. */
const iconLabel = (icon: LeadIcon) =>
  icon.replace(/\d*Icon$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");

const SOURCE_LABELS: Record<LeadSource, string> = {
  builtin: "Built-in",
  personal: "Personal",
  repo: "This repo",
};

const TIER_LABELS: Record<Tier, string> = {
  light: "Light",
  standard: "Standard",
  heavy: "Heavy",
};

const POINT_LABELS: Record<JudgePoint, string> = {
  "model-tier": "Model tier",
  permission: "Permissions",
  report: "Worker reports",
};

const MODE_LABELS: Record<JudgeMode | "global", string> = {
  global: "Use global",
  shadow: "Shadow",
  enforce: "Enforce",
};

/** The threshold a point starts on when it stops using Jev's own. */
const OVERRIDE_THRESHOLD = 0.8;

/** A lead's name as an id: lower case, accents off, dashes between words. */
const slugify = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

/** The page's working copy of a lead: checks as typed, one per line. */
interface Draft {
  input: TeamLeadInput;
  checks: string;
  /** False while the id still follows the name. */
  idEdited: boolean;
  /** The personal lead being edited, by id; null for a new one. */
  editing: string | null;
}

function draftFrom(
  lead: TeamLead,
  editing: string | null,
  overrides?: Partial<TeamLeadInput>,
): Draft {
  const { source: _source, ...input } = lead;
  return {
    input: { ...input, ...overrides },
    checks: lead.checks.join("\n"),
    idEdited: editing !== null,
    editing,
  };
}

function blankDraft(models: readonly AgentModel[]): Draft {
  const model =
    models.find((m) => m.id === "claude-opus-5-5") ??
    models.find((m) => !m.legacy) ??
    models[0];
  const agent = model?.agent ?? "claude";
  const id = model?.id ?? "claude-opus-5-5";
  return {
    input: {
      id: "",
      name: "",
      icon: "Robot02Icon",
      lead: { agent, model: id, effort: null },
      instructions: "",
      workers: [{ agent, model: id, tier: null }],
      maxWorkers: 2,
      checks: [],
      jev: null,
    },
    checks: "",
    idEdited: false,
    editing: null,
  };
}

/** The draft as `parseTeamLead` and `savePersonal` take it. */
const inputOf = (draft: Draft): TeamLeadInput => ({
  ...draft.input,
  checks: draft.checks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
});

/** The first free `base`, `base-2`, `base-3`… among `taken`. */
function freeId(base: string, taken: Set<string>) {
  const root = base || "lead";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const id = `${root.slice(0, 44)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** `Opus 5.5 leads 2 workers, up to 2 at once`: a lead's row, in words. */
function summary(lead: TeamLead) {
  const workers = lead.workers.length;
  return `${modelName(lead.lead.model) ?? lead.lead.model} leads ${workers} ${
    workers === 1 ? "worker" : "workers"
  }, up to ${lead.maxWorkers} at once.`;
}

/**
 * Settings › Agents › Team leads: the presets `/orchestrate` runs under
 * (FE-88).
 *
 * Built-in leads ship with the app and repo leads are files a project checks
 * in, so both are read-only here: "Duplicate as personal" is how to change
 * one. Personal leads are the page's to create, edit and delete.
 *
 * NOTE: Repo leads belong to one project. The page lists them for the project
 * picked in Settings' title bar (`SettingsProjectPicker`), the same one the
 * Project pages show.
 *
 * NOTE: The draft is checked with `parseTeamLead` on every edit, the same
 * check main runs, so Save stays off with the reason shown instead of failing
 * after a round trip.
 */
export function LeadsSection() {
  const surface = window.desktop?.leads;
  const project = useSettingsProject();
  // The same key every other project call uses: its id, or its slug.
  const workspace = useWorkspaceKey(project?.slug);
  const [list, setList] = useState<LeadsList | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<TeamLead | null>(null);
  const models = useMemo(() => allModels(), []);

  const read = useCallback(async () => {
    if (!surface) return;
    try {
      setList(await surface.list(workspace));
      setReadError(null);
    } catch (failure) {
      setReadError(ipcMessage(failure, "Could not read the team leads."));
    }
  }, [surface, workspace]);

  useEffect(() => {
    if (!surface) return;
    let current = true;
    setList(null);
    setReadError(null);
    surface
      .list(workspace)
      .then((next) => current && setList(next))
      .catch(
        (failure: unknown) =>
          current &&
          setReadError(ipcMessage(failure, "Could not read the team leads.")),
      );
    const off = surface.onChange((event) => {
      if (event.workspace === null || event.workspace === workspace)
        void read();
    });
    return () => {
      current = false;
      off();
    };
  }, [surface, workspace, read]);

  async function run(action: () => Promise<LeadsList>, fallback: string) {
    setBusy(true);
    try {
      setList(await action());
      setError(null);
      return true;
    } catch (failure) {
      setError(ipcMessage(failure, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const title = "Team leads";
  const description =
    "Presets for /orchestrate: who leads, what it is told, which workers it may hand work to, and the checks their reports must cover.";

  if (!surface)
    return (
      <SettingsPage
        title={title}
        description="Team leads run in the desktop app."
        sections={[]}
      />
    );

  if (!list)
    return (
      <SettingsPage
        title={title}
        description={description}
        sections={[
          {
            title: "Team leads",
            hideTitle: true,
            content: readError ? (
              <p role="alert" className="text-destructive text-[13px]">
                {readError}
              </p>
            ) : (
              <SettingsCard>
                <ListSkeleton
                  label="Reading the team leads"
                  rows={4}
                  className="py-3"
                />
              </SettingsCard>
            ),
          },
        ]}
      />
    );

  const leads = list.leads;
  const takenIds = new Set(leads.map((lead) => lead.id));

  if (draft)
    return (
      <LeadEditor
        draft={draft}
        setDraft={setDraft}
        models={models}
        takenIds={takenIds}
        busy={busy}
        error={error}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        onSave={(input) =>
          void run(
            () => surface.savePersonal(input),
            "Could not save the team lead.",
          ).then((ok) => ok && setDraft(null))
        }
      />
    );

  const duplicate = (lead: TeamLead) => {
    const name = `${lead.name} copy`.slice(0, 60);
    setError(null);
    setDraft(
      draftFrom(lead, null, { name, id: freeId(slugify(name), takenIds) }),
    );
  };

  const defaultLabel = (id: string) =>
    id === "none" ? "None" : (leads.find((lead) => lead.id === id)?.name ?? id);

  const sections: SettingsSectionSpec[] = [
    {
      title: "Default",
      rows: [
        {
          label: "Default team lead",
          description: list.defaultId
            ? "The lead a new /orchestrate proposal starts on. You can pick another on the proposal."
            : "None: a new proposal starts with no preset, on the Decision tiers.",
          keywords: "default lead preset proposal orchestrate",
          control: (
            <Select
              value={list.defaultId ?? "none"}
              disabled={busy}
              onValueChange={(value) =>
                void run(
                  () =>
                    surface.setDefault(
                      value === "none" ? null : (value as string),
                    ),
                  "Could not set the default team lead.",
                )
              }
            >
              <SelectTrigger
                aria-label="Default team lead"
                className="min-w-40"
              >
                <SelectValue>
                  {(value: string) => defaultLabel(value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {leads.map((lead) => (
                  <SelectItem key={`${lead.source}:${lead.id}`} value={lead.id}>
                    {lead.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
      ],
    },
    {
      title: "Team leads",
      keywords: `team lead leads preset built-in personal repo duplicate edit delete new ${leads
        .map((lead) => lead.name)
        .join(" ")}`,
      content: (
        <SettingsCard>
          {leads.length === 0 ? (
            <div className="text-muted-foreground px-4 py-3.5 text-[13px]">
              No team leads yet. Create one to give /orchestrate a preset.
            </div>
          ) : (
            leads.map((lead) => (
              <LeadRow
                key={`${lead.source}:${lead.id}`}
                lead={lead}
                busy={busy}
                onDuplicate={() => duplicate(lead)}
                onEdit={() => {
                  setError(null);
                  setDraft(draftFrom(lead, lead.id));
                }}
                onRemove={() => setRemoving(lead)}
              />
            ))
          )}
          <div className="flex items-center justify-between gap-8 px-4 py-3.5">
            <span className="text-muted-foreground text-[13px] leading-relaxed">
              {workspace
                ? `Repo leads are read from ${project?.name ?? workspace}, the project picked above.`
                : "Pick a project above to see its repo leads."}
            </span>
            <Button
              size="lg"
              className={SETTINGS_BUTTON}
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDraft(blankDraft(models));
              }}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={1.5} />
              New team lead
            </Button>
          </div>
        </SettingsCard>
      ),
    },
  ];

  if (list.errors.length)
    sections.push({
      title: "Repo files not read",
      keywords: "error parse repo file json invalid",
      content: (
        <SettingsCard>
          {list.errors.map((entry) => (
            <div key={entry.file} className="flex flex-col gap-1 px-4 py-3.5">
              <code className="text-[13px] font-medium break-all">
                {entry.file}
              </code>
              <span className="text-destructive text-[13px] leading-relaxed">
                {entry.error}
              </span>
            </div>
          ))}
        </SettingsCard>
      ),
    });

  if (error)
    sections.push({
      title: "Problem",
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });

  return (
    <>
      <SettingsPage
        title={title}
        description={description}
        sections={sections}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the team lead from this Mac. Runs already started
              under it keep going. If it is the default, new proposals start
              with none.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="border-0"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target)
                  void run(
                    () => surface.removePersonal(target.id),
                    "Could not delete the team lead.",
                  );
              }}
            >
              Delete team lead
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function LeadRow({
  lead,
  busy,
  onDuplicate,
  onEdit,
  onRemove,
}: {
  lead: TeamLead;
  busy: boolean;
  onDuplicate: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-4 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <HugeiconsIcon
          icon={ICONS[lead.icon]}
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{lead.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs font-normal">
              {SOURCE_LABELS[lead.source]}
            </span>
          </span>
          <span className="text-muted-foreground text-[13px] leading-relaxed">
            {summary(lead)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {lead.source === "personal" ? (
          <>
            <Button
              size="lg"
              className={SETTINGS_BUTTON}
              variant="outline"
              disabled={busy}
              onClick={onEdit}
            >
              Edit
            </Button>
            <Button
              size="lg"
              className={`${SETTINGS_BUTTON} border-0`}
              variant="destructive"
              disabled={busy}
              onClick={onRemove}
            >
              Delete
            </Button>
          </>
        ) : (
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            disabled={busy}
            onClick={onDuplicate}
          >
            Duplicate as personal
          </Button>
        )}
      </div>
    </div>
  );
}

/** One labelled line inside a `content` card, drawn like a settings row. */
function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        {description ? (
          <span className="text-muted-foreground text-[13px] leading-relaxed">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function ModelSelect({
  value,
  models,
  label,
  onPick,
}: {
  value: string;
  models: readonly AgentModel[];
  label: string;
  onPick: (model: AgentModel) => void;
}) {
  const options = models.filter((model) => !model.legacy || model.id === value);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const model = models.find((m) => m.id === next);
        if (model) onPick(model);
      }}
    >
      <SelectTrigger aria-label={label} className="min-w-36">
        <SelectValue>
          {(current: string) => modelName(current) ?? current}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LeadEditor({
  draft,
  setDraft,
  models,
  takenIds,
  busy,
  error,
  onCancel,
  onSave,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  models: readonly AgentModel[];
  takenIds: Set<string>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: TeamLeadInput) => void;
}) {
  const { input } = draft;
  const update = (change: Partial<TeamLeadInput>) =>
    setDraft({ ...draft, input: { ...input, ...change } });

  // Main's own check, run on every edit: Save waits until it passes.
  let problem: string | null = null;
  let parsed: TeamLeadInput | null = null;
  try {
    const { source: _source, ...rest } = parseTeamLead(
      inputOf(draft),
      "personal",
    );
    parsed = rest;
  } catch (failure) {
    problem = failure instanceof Error ? failure.message : String(failure);
  }
  if (!problem && draft.editing === null && takenIds.has(input.id))
    problem = `Another team lead already uses the id “${input.id}”.`;

  const setWorker = (
    index: number,
    change: Partial<TeamLeadInput["workers"][number]>,
  ) =>
    update({
      workers: input.workers.map((worker, i) =>
        i === index ? { ...worker, ...change } : worker,
      ),
    });

  const setPoint = (point: JudgePoint, mode: JudgeMode | "global") => {
    const jev = { ...(input.jev ?? {}) };
    if (mode === "global") delete jev[point];
    else
      jev[point] = {
        mode,
        threshold: jev[point]?.threshold ?? OVERRIDE_THRESHOLD,
      };
    update({ jev: Object.keys(jev).length ? jev : null });
  };

  const sections: SettingsSectionSpec[] = [
    {
      title: "Team lead",
      rows: [
        {
          label: "Name",
          keywords: "name title",
          control: (
            <Input
              aria-label="Team lead name"
              className="w-64"
              placeholder="e.g. Careful reviewer"
              value={input.name}
              onChange={(event) => {
                const name = event.target.value;
                setDraft({
                  ...draft,
                  input: {
                    ...input,
                    name,
                    id: draft.idEdited ? input.id : slugify(name),
                  },
                });
              }}
            />
          ),
        },
        {
          label: "Id",
          description:
            draft.editing !== null
              ? "Fixed once saved: runs and the default refer to it."
              : "Lower case, digits and dashes. Follows the name until you change it.",
          keywords: "id slug file",
          control: (
            <Input
              aria-label="Team lead id"
              className="w-64 font-mono"
              disabled={draft.editing !== null}
              value={input.id}
              aria-invalid={!!input.id && !LEAD_ID_PATTERN.test(input.id)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  idEdited: true,
                  input: { ...input, id: event.target.value },
                })
              }
            />
          ),
        },
        {
          label: "Icon",
          keywords: "icon symbol",
          control: (
            <Select
              value={input.icon}
              onValueChange={(value) => update({ icon: value as LeadIcon })}
            >
              <SelectTrigger aria-label="Team lead icon" className="min-w-36">
                <SelectValue>
                  {(value: LeadIcon) => (
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon
                        icon={ICONS[value]}
                        className="size-3.5"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {iconLabel(value)}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LEAD_ICONS.map((icon) => (
                  <SelectItem key={icon} value={icon}>
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon
                        icon={ICONS[icon]}
                        className="size-3.5"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {iconLabel(icon)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
        {
          label: "Lead model",
          description: "The CLI, model and effort the lead itself runs on.",
          keywords: "lead model effort cli claude codex",
          control: (
            <>
              <ModelSelect
                value={input.lead.model}
                models={models}
                label="Lead model"
                onPick={(model) =>
                  update({
                    lead: {
                      ...input.lead,
                      model: model.id,
                      agent: model.agent,
                    },
                  })
                }
              />
              <Select
                value={input.lead.effort ?? "default"}
                onValueChange={(value) =>
                  update({
                    lead: {
                      ...input.lead,
                      effort: value === "default" ? null : (value as Effort),
                    },
                  })
                }
              >
                <SelectTrigger aria-label="Lead effort" className="min-w-24">
                  <SelectValue>
                    {(value: string) =>
                      value === "default"
                        ? "Default"
                        : EFFORT_LABELS[value as Effort]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {EFFORTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {EFFORT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ),
        },
      ],
    },
    {
      title: "Instructions",
      keywords: "instructions prompt system told lead",
      content: (
        <SettingsCard className="p-3">
          <Textarea
            aria-label="Team lead instructions"
            className="min-h-32 border-0 bg-transparent text-[13px] md:text-[13px] dark:bg-transparent"
            placeholder="Told to the lead before your request. Optional."
            value={input.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </SettingsCard>
      ),
    },
    {
      title: "Workers",
      keywords: "workers worker model tier max parallel at once",
      content: (
        <SettingsCard>
          {input.workers.map((worker, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position; two may share a model while being edited.
              key={index}
              className="flex items-center justify-between gap-8 px-4 py-3"
            >
              <span className="text-sm font-medium">Worker {index + 1}</span>
              <div className="flex shrink-0 items-center gap-2">
                <ModelSelect
                  value={worker.model}
                  models={models}
                  label={`Worker ${index + 1} model`}
                  onPick={(model) =>
                    setWorker(index, { model: model.id, agent: model.agent })
                  }
                />
                <Select
                  value={worker.tier ?? "none"}
                  onValueChange={(value) =>
                    setWorker(index, {
                      tier: value === "none" ? null : (value as Tier),
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={`Worker ${index + 1} tier`}
                    className="min-w-28"
                  >
                    <SelectValue>
                      {(value: string) =>
                        value === "none"
                          ? "No tier"
                          : TIER_LABELS[value as Tier]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No tier</SelectItem>
                    {TIERS.map((tier) => (
                      <SelectItem key={tier} value={tier}>
                        {TIER_LABELS[tier]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon-lg"
                  variant="ghost"
                  aria-label={`Remove worker ${index + 1}`}
                  disabled={input.workers.length <= 1}
                  onClick={() =>
                    update({
                      workers: input.workers.filter((_, i) => i !== index),
                    })
                  }
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.5} />
                </Button>
              </div>
            </div>
          ))}
          <Field
            label="Add a worker"
            description={`Up to ${LEAD_WORKERS_MAX}, each on a different model.`}
          >
            <Button
              size="lg"
              className={SETTINGS_BUTTON}
              variant="outline"
              disabled={input.workers.length >= LEAD_WORKERS_MAX}
              onClick={() => {
                // A model no worker uses yet, so the new row passes at once.
                const used = new Set(input.workers.map((w) => w.model));
                const model =
                  models.find((m) => !m.legacy && !used.has(m.id)) ??
                  models.find((m) => !m.legacy) ??
                  models[0];
                if (model)
                  update({
                    workers: [
                      ...input.workers,
                      { agent: model.agent, model: model.id, tier: null },
                    ],
                  });
              }}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={1.5} />
              Add worker
            </Button>
          </Field>
          <Field
            label="At most at once"
            description="How many workers may run in parallel."
          >
            <Select
              value={String(input.maxWorkers)}
              onValueChange={(value) => update({ maxWorkers: Number(value) })}
            >
              <SelectTrigger
                aria-label="Most workers at once"
                className="min-w-20"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: WORKERS_MAX }, (_, i) =>
                  String(i + 1),
                ).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </SettingsCard>
      ),
    },
    {
      title: "Checks",
      keywords: "checks report verify accept",
      content: (
        <SettingsCard className="flex flex-col gap-2 p-3">
          <Textarea
            aria-label="Team lead checks"
            className="min-h-20 border-0 bg-transparent font-mono text-[13px] md:text-[13px] dark:bg-transparent"
            placeholder={"bun run typecheck\nbun run build"}
            value={draft.checks}
            onChange={(event) =>
              setDraft({ ...draft, checks: event.target.value })
            }
          />
          <span className="text-muted-foreground px-2 text-[13px] leading-relaxed">
            One per line: what a worker's report must show before the lead
            accepts it.
          </span>
        </SettingsCard>
      ),
    },
    {
      title: "Decision",
      rows: JUDGE_POINTS.map((point) => {
        const override = input.jev?.[point];
        return {
          label: POINT_LABELS[point],
          description: override
            ? override.mode === "shadow"
              ? "Shadow under this lead: the judge answers and logs, the lead decides."
              : `Enforce under this lead: the judge decides at ${Math.round(
                  override.threshold * 100,
                )}% or more.`
            : "Uses the mode and threshold set on the Decision page.",
          keywords: "decision jev judge override shadow enforce threshold",
          control: (
            <>
              <Select
                value={override?.mode ?? "global"}
                onValueChange={(value) =>
                  setPoint(point, value as JudgeMode | "global")
                }
              >
                <SelectTrigger
                  aria-label={`${POINT_LABELS[point]} judge mode`}
                  className="min-w-28"
                >
                  <SelectValue>
                    {(value: JudgeMode | "global") => MODE_LABELS[value]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(["global", "shadow", "enforce"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {MODE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {override && (
                <Input
                  aria-label={`${POINT_LABELS[point]} judge threshold`}
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  className="w-20"
                  value={override.threshold}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      update({
                        jev: {
                          ...input.jev,
                          [point]: {
                            ...override,
                            threshold: Math.min(1, Math.max(0, value)),
                          },
                        },
                      });
                  }}
                />
              )}
            </>
          ),
        };
      }),
    },
    {
      title: "Save",
      hideTitle: true,
      rows: [
        {
          label: problem ? "Not ready to save" : "Ready to save",
          description:
            problem ??
            "Saved for every project on this Mac, as a personal team lead.",
          keywords: "save cancel",
          control: (
            <>
              <Button
                size="lg"
                className={SETTINGS_BUTTON}
                variant="outline"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                size="lg"
                className={SETTINGS_BUTTON}
                disabled={busy || !parsed || !!problem}
                onClick={() => parsed && onSave(parsed)}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </>
          ),
        },
      ],
    },
  ];

  if (error)
    sections.push({
      title: "Problem",
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });

  return (
    <SettingsPage
      title={
        draft.editing !== null
          ? `Edit ${input.name || draft.editing}`
          : "New team lead"
      }
      description="A personal team lead: yours, for every project on this Mac."
      sections={sections}
    />
  );
}
