// The conductor editor (FE-88, FE-95), drawn in the rail's New/Edit
// conductor dialog. Settings no longer has a page for conductors (FE-95).

import {
  AiChipIcon,
  Brain02Icon,
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
import type { ReactNode } from "react";
import {
  type AgentModel,
  agentOfModel,
  DEFAULT_SETTINGS,
  modelName,
} from "#/../shared/conversation";
import {
  CONDUCTOR_DEFAULTS,
  CONDUCTOR_INSTRUCTIONS,
  type LeadIcon,
  type LeadSource,
  parseTeamLead,
  type TeamLead,
  type TeamLeadInput,
} from "#/../shared/orchestration";
import {
  ModelMenu,
  PermissionMenu,
} from "#/components/shared/conversation/composer.menus";
import type { SettingsSectionSpec } from "#/components/shared/settings/settings-page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

export const ICONS: Record<LeadIcon, typeof Robot02Icon> = {
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
export const iconLabel = (icon: LeadIcon) =>
  icon.replace(/\d*Icon$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");

export const SOURCE_LABELS: Record<LeadSource, string> = {
  personal: "Personal",
  repo: "This repo",
};

/** A lead's name as an id: lower case, accents off, dashes between words. */
export const slugify = (name: string) =>
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
export interface Draft {
  input: TeamLeadInput;
  checks: string;
  /** False while the id still follows the name. */
  idEdited: boolean;
  /** The personal lead being edited, by id; null for a new one. */
  editing: string | null;
}

export function draftFrom(
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

export function blankDraft(models: readonly AgentModel[]): Draft {
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
      instructions: CONDUCTOR_INSTRUCTIONS,
      ...CONDUCTOR_DEFAULTS,
      workers: [...CONDUCTOR_DEFAULTS.workers],
      checks: [...CONDUCTOR_DEFAULTS.checks],
      jev: null,
      permission: null,
    },
    checks: "",
    idEdited: false,
    editing: null,
  };
}

/** The draft as `parseTeamLead` and `savePersonal` take it. */
export const inputOf = (draft: Draft): TeamLeadInput => ({
  ...draft.input,
  checks: draft.checks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
});

/** The first free `base`, `base-2`, `base-3`… among `taken`. */
export function freeId(base: string, taken: Set<string>) {
  const root = base || "lead";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const id = `${root.slice(0, 44)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** One labelled line inside a `content` card, drawn like a settings row. */
function _Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] font-medium">{label}</span>
        {description ? (
          <span className="text-muted-foreground text-xs leading-relaxed">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function _ModelSelect({
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

/**
 * A conductor draft's editor, as sections the dialog lays out on its pages
 * (FE-95): `Model` (the composer's model and permission pills).
 *
 * `problem` is main's own check (`parseTeamLead`) run on every edit, so
 * Save stays off with the reason shown; `parsed` is what Save sends.
 */
export function conductorEditor({
  draft,
  setDraft,
  takenIds,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  takenIds: Set<string>;
}): {
  sections: SettingsSectionSpec[];
  problem: string | null;
  parsed: TeamLeadInput | null;
} {
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
    problem = `Another conductor already uses the id “${input.id}”.`;

  const sections: SettingsSectionSpec[] = [
    {
      title: "Model",
      rows: [
        {
          label: "Model",
          description: "What it thinks and replies with, and how hard.",
          keywords: "lead model effort cli claude codex",
          // The composer's own pills (FE-95): the same model and effort a
          // conversation picks, shown the same way.
          control: (
            <ModelMenu
              side="bottom"
              fast={false}
              settings={{
                ...DEFAULT_SETTINGS,
                model: input.lead.model,
                effort: input.lead.effort ?? DEFAULT_SETTINGS.effort,
              }}
              onChange={(next) =>
                update({
                  lead: {
                    ...input.lead,
                    ...(next.model
                      ? { model: next.model, agent: agentOfModel(next.model) }
                      : {}),
                    ...(next.effort ? { effort: next.effort } : {}),
                  },
                })
              }
            />
          ),
        },
        {
          label: "Permissions",
          description: "What it may do without asking.",
          keywords: "permission permissions mode supervised auto bypass",
          control: (
            <PermissionMenu
              side="bottom"
              permission={input.permission ?? DEFAULT_SETTINGS.permission}
              onChange={(permission) => update({ permission })}
            />
          ),
        },
      ],
    },
  ];

  return { sections, problem, parsed };
}
