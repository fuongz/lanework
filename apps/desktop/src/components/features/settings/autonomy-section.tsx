import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  AUTONOMY_COPY,
  AUTONOMY_LEVELS,
  type AutonomyKnobs,
  type AutonomyLevel,
  type AutonomySettings,
  effectiveKnobs,
  isAutonomyLevel,
  isCustom,
  LEVEL_KNOBS,
  realOverrides,
} from "#/../shared/autonomy";
import {
  isPermission,
  PERMISSION_COPY,
  PERMISSIONS,
  type Permission,
} from "#/../shared/conversation";
import type { Project } from "#/../shared/projects";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsRowSpec,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { SettingsScope } from "#/components/shared/settings/settings-scope";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { useAutonomy, useProjectAutonomy } from "#/stores/autonomy";
import { useSettingsProject } from "#/stores/settings-project";

const TITLE = "Autonomy";

const DESCRIPTION =
  "How far an agent handed one of this project's cards may go on its own. One level sets the permission it starts in, whether decisions are approved for it, whether it commits, and whether it moves the card to review.";

/** The level a fresh dial starts at from the empty state. */
const FIRST_LEVEL: AutonomyLevel = "recommended";

/** The switches among the knobs; `permission` is a menu. */
const SWITCHES: {
  key: Exclude<keyof AutonomyKnobs, "permission">;
  label: string;
  description: string;
  keywords: string;
}[] = [
  {
    key: "autoApprove",
    label: "Approve recommended decisions",
    description:
      "When a card is assigned, approve its recommended options without asking first.",
    keywords: "auto approve approval decisions recommended dialog assign skip",
  },
  {
    key: "commit",
    label: "Commit locally",
    description:
      "The agent may commit its work on this machine. It never pushes.",
    keywords: "commit git local push",
  },
  {
    key: "toReview",
    label: "Move to review",
    description:
      "The agent moves the card to the review lane once its work is verified.",
    keywords: "review lane move status hand off handoff verified done",
  },
];

function NoProject() {
  return (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={DashboardSpeed02Icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Add a project to choose how far its agents may go.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsCard>
  );
}

/** The dial before anyone set it, with the way to set it. */
function NotSet({ busy, onSet }: { busy: boolean; onSet: () => void }) {
  return (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={DashboardSpeed02Icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>Not set</EmptyTitle>
          <EmptyDescription>
            Agents follow the repo’s rules and their CLI’s own settings. Pick a
            level below, or start from {AUTONOMY_COPY[FIRST_LEVEL].label}.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            disabled={busy}
            onClick={onSet}
          >
            Use {AUTONOMY_COPY[FIRST_LEVEL].label}
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsCard>
  );
}

/** The four levels, one picked (or none while the dial is not set). */
function LevelList({
  level,
  custom,
  onPick,
}: {
  level: AutonomyLevel | null;
  custom: boolean;
  onPick: (level: AutonomyLevel) => void;
}) {
  return (
    <SettingsCard>
      <RadioGroup
        aria-label="Autonomy level"
        value={level ?? ""}
        onValueChange={(next) => {
          if (isAutonomyLevel(next)) onPick(next);
        }}
        className="gap-0 divide-border divide-y"
      >
        {AUTONOMY_LEVELS.map((entry) => {
          const id = `autonomy-level-${entry}`;
          return (
            <div key={entry} className="flex items-start gap-3 px-4 py-3.5">
              <RadioGroupItem id={id} value={entry} className="mt-0.5" />
              <label htmlFor={id} className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {AUTONOMY_COPY[entry].label}
                  {custom && entry === level && (
                    <Badge variant="secondary">Custom</Badge>
                  )}
                </span>
                <span className="text-muted-foreground text-[13px] leading-relaxed">
                  {AUTONOMY_COPY[entry].description}
                </span>
              </label>
            </div>
          );
        })}
      </RadioGroup>
    </SettingsCard>
  );
}

function ProjectAutonomy({ project }: { project: Project }) {
  const dial = useProjectAutonomy(project.slug);
  const error = useAutonomy((state) => state.errors[project.slug]);
  const save = useAutonomy((state) => state.set);
  const [busy, setBusy] = useState(false);

  const write = async (next: AutonomySettings | null) => {
    setBusy(true);
    await save(project.slug, next);
    setBusy(false);
  };

  /** A new level drops every knob turned by hand (PD-08). */
  const pick = (level: AutonomyLevel) => void write({ level, overrides: {} });

  const turn = (change: Partial<AutonomyKnobs>) => {
    if (!dial) return;
    void write({
      level: dial.level,
      overrides: realOverrides(dial.level, { ...dial.overrides, ...change }),
    });
  };

  const sections: SettingsSectionSpec[] = [];
  if (error)
    sections.push({
      title: "Error",
      hideTitle: true,
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });

  if (dial === undefined) {
    if (!error)
      sections.push({
        title: "Reading",
        hideTitle: true,
        content: (
          <ListSkeleton
            label={`Reading ${project.name}’s autonomy level`}
            rows={4}
            className="px-0"
          />
        ),
      });
  } else {
    const custom = dial !== null && isCustom(dial);
    if (dial === null)
      sections.push({
        title: "Not set",
        hideTitle: true,
        keywords: "autonomy not set unset repo rules cli settings",
        content: <NotSet busy={busy} onSet={() => pick(FIRST_LEVEL)} />,
      });
    sections.push({
      title: "Level",
      keywords: `autonomy level dial ${AUTONOMY_LEVELS.map((entry) => `${AUTONOMY_COPY[entry].label} ${AUTONOMY_COPY[entry].description}`).join(" ")} custom reset`,
      content: (
        <div className="flex flex-col gap-3">
          {dial && (
            <div className="flex items-center justify-between gap-6">
              <span className="text-muted-foreground text-[13px] leading-relaxed">
                {custom
                  ? `Custom: ${AUTONOMY_COPY[dial.level].label} with settings changed by hand.`
                  : `Every setting below follows ${AUTONOMY_COPY[dial.level].label}.`}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {custom && (
                  <Button
                    variant="outline"
                    size="lg"
                    className={SETTINGS_BUTTON}
                    disabled={busy}
                    onClick={() => pick(dial.level)}
                  >
                    Reset to {AUTONOMY_COPY[dial.level].label}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="lg"
                  className={SETTINGS_BUTTON}
                  disabled={busy}
                  onClick={() => void write(null)}
                >
                  Clear level
                </Button>
              </div>
            </div>
          )}
          <LevelList
            level={dial?.level ?? null}
            custom={custom}
            onPick={pick}
          />
        </div>
      ),
    });
    if (dial) sections.push(knobSection(dial, busy, turn));
  }

  return (
    <SettingsPage
      scope={<SettingsScope />}
      title={TITLE}
      description={DESCRIPTION}
      sections={sections}
    />
  );
}

/** The four knobs the level sets, each showing its value and editable. */
function knobSection(
  dial: AutonomySettings,
  busy: boolean,
  turn: (change: Partial<AutonomyKnobs>) => void,
): SettingsSectionSpec {
  const knobs = effectiveKnobs(dial);
  const base = LEVEL_KNOBS[dial.level];
  const changed = (key: keyof AutonomyKnobs) =>
    knobs[key] !== base[key] ? (
      <Badge variant="outline">
        Changed from {AUTONOMY_COPY[dial.level].label}
      </Badge>
    ) : null;
  const rows: SettingsRowSpec[] = [
    {
      label: "Permission",
      description: PERMISSION_COPY[knobs.permission].description,
      keywords: `permission mode start ${PERMISSIONS.map((entry) => PERMISSION_COPY[entry].label).join(" ")}`,
      byline: changed("permission"),
      control: (
        <Select
          value={knobs.permission}
          disabled={busy}
          onValueChange={(next) => {
            if (isPermission(next)) turn({ permission: next });
          }}
        >
          <SelectTrigger aria-label="Permission">
            <SelectValue>
              {(current: Permission) => PERMISSION_COPY[current].label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PERMISSIONS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {PERMISSION_COPY[entry].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    ...SWITCHES.map(
      ({ key, label, description, keywords }): SettingsRowSpec => ({
        label,
        description,
        keywords,
        byline: changed(key),
        control: (
          <Switch
            aria-label={label}
            checked={knobs[key]}
            disabled={busy}
            onCheckedChange={(checked) => turn({ [key]: checked })}
          />
        ),
      }),
    ),
  ];
  return { title: "What it sets", rows };
}

/**
 * Settings › Autonomy: the picked project's autonomy dial (PD-08). One level
 * derives the four knobs below it; turning a knob by hand makes the dial
 * read Custom until it is reset.
 *
 * Always one project: the dial is kept per project, so the scope row has no
 * "All projects".
 */
export function AutonomySection() {
  const project = useSettingsProject();
  if (!project)
    return (
      <SettingsPage
        scope={<SettingsScope />}
        title={TITLE}
        description={DESCRIPTION}
        sections={[
          { title: "No project", hideTitle: true, content: <NoProject /> },
        ]}
      />
    );
  // Keyed by slug: picking another project starts from its own read.
  return <ProjectAutonomy key={project.slug} project={project} />;
}
