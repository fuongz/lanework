import {
  Delete02Icon,
  NoteEditIcon,
  SquareUnlock02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useMemo, useState } from "react";
import type {
  AutoAllowEntry,
  PermissionEffect,
  PermissionRule,
} from "#/../shared/permissions";
import type { Project } from "#/../shared/projects";
import { useTeamLeads } from "#/components/shared/conversation/composer";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { SettingsScope } from "#/components/shared/settings/settings-scope";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { useProjectKey } from "#/hooks/use-project-key";
import { draftProblem, ruleLabel } from "#/lib/permission-rules";
import { relativeTime } from "#/lib/relative-time";
import { useSettingsProject } from "#/stores/settings-project";
import { usePermissionRules } from "./use-permission-rules";

const DESCRIPTION =
  "What this project's conversations may do without asking, and what they always ask about. Rules apply to every agent, or to one conductor.";

/** Audit rows drawn at first, and how many each "Show more" adds. */
const PAGE = 20;

/** The scope value for "every conversation": a select has no empty item. */
const EVERYONE = "__everyone__";

interface ConductorName {
  id: string;
  name: string;
}

function Nothing({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={SquareUnlock02Icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsCard>
  );
}

/** One rule's fields, edited in place under its row. */
function RuleEditor({
  rule,
  conductors,
  onSave,
  onCancel,
}: {
  rule: PermissionRule;
  conductors: readonly ConductorName[];
  onSave: (rule: PermissionRule) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [tool, setTool] = useState(rule.tool);
  const [pattern, setPattern] = useState(rule.pattern ?? "");
  const [effect, setEffect] = useState<PermissionEffect>(rule.effect);
  const [conductor, setConductor] = useState(rule.conductor ?? EVERYONE);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = draftProblem({ tool, pattern });
  // A conductor that is gone still names the rule; keep it choosable.
  const choices = useMemo(
    () =>
      rule.conductor && !conductors.some((entry) => entry.id === rule.conductor)
        ? [...conductors, { id: rule.conductor, name: rule.conductor }]
        : conductors,
    [conductors, rule.conductor],
  );

  const save = async () => {
    if (problem) return;
    setBusy(true);
    const { pattern: _pattern, conductor: _conductor, ...base } = rule;
    const message = await onSave({
      ...base,
      tool: tool.trim(),
      effect,
      ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
      ...(conductor !== EVERYONE ? { conductor } : {}),
    });
    setBusy(false);
    if (message) setFailure(message);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Tool</span>
          <Input
            aria-label="Tool"
            value={tool}
            disabled={busy || rule.seeded}
            onChange={(event) => setTool(event.target.value)}
            className="font-mono"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            Pattern, empty for the whole tool
          </span>
          <Input
            aria-label="Pattern"
            value={pattern}
            disabled={busy}
            onChange={(event) => setPattern(event.target.value)}
            className="font-mono"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Applies to</span>
          <Select
            value={conductor}
            onValueChange={(next) => next && setConductor(next)}
            disabled={busy}
          >
            <SelectTrigger aria-label="Conductor scope">
              <SelectValue>
                {(current: string) =>
                  current === EVERYONE
                    ? "Every conversation"
                    : (choices.find((entry) => entry.id === current)?.name ??
                      current)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERYONE}>Every conversation</SelectItem>
              {choices.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  Only {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!rule.seeded && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">What it does</span>
            <Select
              value={effect}
              onValueChange={(next) =>
                (next === "allow" || next === "ask") && setEffect(next)
              }
              disabled={busy}
            >
              <SelectTrigger aria-label="Rule effect">
                <SelectValue>
                  {(current: string) =>
                    current === "allow" ? "Allow automatically" : "Ask first"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow automatically</SelectItem>
                <SelectItem value="ask">Ask first</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {(problem || failure) && (
        <p role="alert" className="text-destructive text-xs leading-relaxed">
          {failure ?? problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className={SETTINGS_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className={SETTINGS_BUTTON}
          disabled={busy || problem !== null}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const RuleRow = memo(function RuleRow({
  rule,
  conductors,
  editing,
  busy,
  onEdit,
  onSave,
  onRemove,
}: {
  rule: PermissionRule;
  conductors: readonly ConductorName[];
  editing: boolean;
  busy: boolean;
  onEdit: (id: string | null) => void;
  onSave: (rule: PermissionRule) => Promise<string | null>;
  onRemove: (rule: PermissionRule) => void;
}) {
  const scope = rule.conductor
    ? (conductors.find((entry) => entry.id === rule.conductor)?.name ??
      rule.conductor)
    : null;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <code className="font-mono text-[13px] font-medium break-all">
              {ruleLabel(rule)}
            </code>
            {rule.seeded && <Badge variant="secondary">Seeded</Badge>}
            {scope && <Badge variant="outline">Only {scope}</Badge>}
          </span>
          {rule.seeded && (
            <span className="text-muted-foreground text-xs leading-relaxed">
              Ships with Lanework. You can edit it, but not remove it.
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 self-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${ruleLabel(rule)}`}
            title="Edit"
            aria-pressed={editing}
            disabled={busy}
            onClick={() => onEdit(editing ? null : rule.id)}
          >
            <HugeiconsIcon
              icon={NoteEditIcon}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </Button>
          {!rule.seeded && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${ruleLabel(rule)}`}
              title="Delete"
              className="text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => onRemove(rule)}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <RuleEditor
          rule={rule}
          conductors={conductors}
          onSave={onSave}
          onCancel={() => onEdit(null)}
        />
      )}
    </div>
  );
});

function AuditList({
  entries,
  rules,
  conductors,
}: {
  entries: readonly AutoAllowEntry[];
  rules: readonly PermissionRule[];
  conductors: readonly ConductorName[];
}) {
  const [shown, setShown] = useState(PAGE);
  // Newest first. `now` is read once per list, never on a timer.
  const { newest, now } = useMemo(
    () => ({ newest: [...entries].reverse(), now: Date.now() }),
    [entries],
  );
  const labels = useMemo(
    () => new Map(rules.map((rule) => [rule.id, ruleLabel(rule)])),
    [rules],
  );
  const names = useMemo(
    () => new Map(conductors.map((entry) => [entry.id, entry.name])),
    [conductors],
  );
  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        {newest.slice(0, shown).map((entry) => (
          <div
            key={`${entry.at}:${entry.conversation}:${entry.ruleId}:${entry.summary}`}
            className="flex flex-col gap-1 px-4 py-3"
          >
            <code className="font-mono text-[13px] break-all">
              {entry.summary}
            </code>
            <span className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
              <span>{entry.tool}</span>
              <span>Rule {labels.get(entry.ruleId) ?? "since removed"}</span>
              {entry.conductor && (
                <span>{names.get(entry.conductor) ?? entry.conductor}</span>
              )}
              <span>{relativeTime(entry.at, now)}</span>
            </span>
          </div>
        ))}
      </SettingsCard>
      {newest.length > shown && (
        <Button
          variant="ghost"
          className={`${SETTINGS_BUTTON} self-center`}
          onClick={() => setShown((count) => count + PAGE)}
        >
          Show more ({newest.length - shown})
        </Button>
      )}
    </div>
  );
}

function RuleList({
  rules,
  conductors,
  save,
  remove,
  emptyTitle,
  emptyDescription,
}: {
  rules: readonly PermissionRule[];
  conductors: readonly ConductorName[];
  save: (rule: PermissionRule) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const saveRule = useCallback(
    async (rule: PermissionRule) => {
      const message = await save(rule);
      if (!message) setEditing(null);
      return message;
    },
    [save],
  );
  const removeRule = useCallback(
    async (rule: PermissionRule) => {
      setBusy(true);
      const message = await remove(rule.id);
      setBusy(false);
      setFailure(message);
    },
    [remove],
  );

  if (rules.length === 0)
    return <Nothing title={emptyTitle} description={emptyDescription} />;
  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            conductors={conductors}
            editing={editing === rule.id}
            busy={busy}
            onEdit={setEditing}
            onSave={saveRule}
            onRemove={(entry) => void removeRule(entry)}
          />
        ))}
      </SettingsCard>
      {failure && (
        <p role="alert" className="text-destructive text-[13px]">
          {failure}
        </p>
      )}
    </div>
  );
}

function ProjectPermissions({ project }: { project: Project }) {
  const key = useProjectKey(project.slug);
  const { rules, audit, error, save, remove } = usePermissionRules(key);
  const leads = useTeamLeads(key);
  const conductors = useMemo<ConductorName[]>(
    () => (leads?.leads ?? []).map(({ id, name }) => ({ id, name })),
    [leads],
  );
  const groups = useMemo(
    () => ({
      allow: (rules ?? []).filter((rule) => rule.effect === "allow"),
      ask: (rules ?? []).filter((rule) => rule.effect === "ask"),
    }),
    [rules],
  );

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
  if (!rules)
    sections.push({
      title: "Reading",
      hideTitle: true,
      content: error ? null : (
        <ListSkeleton
          label={`Reading ${project.name}’s permission rules`}
          rows={4}
          className="px-0"
        />
      ),
    });
  else {
    sections.push(
      {
        title: "Allow automatically",
        keywords: `permission rule allow ${groups.allow.map(ruleLabel).join(" ")}`,
        content: (
          <RuleList
            rules={groups.allow}
            conductors={conductors}
            save={save}
            remove={remove}
            emptyTitle="Nothing is allowed automatically"
            emptyDescription="Choose Always allow on a permission request in a conversation to add a rule here."
          />
        ),
      },
      {
        title: "Ask first",
        keywords: `permission rule ask seeded ${groups.ask.map(ruleLabel).join(" ")}`,
        content: (
          <RuleList
            rules={groups.ask}
            conductors={conductors}
            save={save}
            remove={remove}
            emptyTitle="No rule asks first"
            emptyDescription="Anything an allow rule does not cover is asked about anyway."
          />
        ),
      },
      {
        title: "Recent automatic allows",
        keywords: "permission audit recent automatic allowed history log",
        content: !audit ? (
          <ListSkeleton
            label="Reading the audit list"
            rows={3}
            lines={2}
            className="px-0"
          />
        ) : audit.length === 0 ? (
          <Nothing
            title="Nothing allowed automatically yet"
            description="What a rule lets through is listed here, newest first."
          />
        ) : (
          <AuditList entries={audit} rules={rules} conductors={conductors} />
        ),
      },
    );
  }

  return (
    <SettingsPage
      scope={<SettingsScope />}
      title="Permissions"
      description={DESCRIPTION}
      sections={sections}
    />
  );
}

/**
 * Settings › Permissions: the picked project's permission rules, grouped as
 * Allow automatically and Ask first, with what ran on a rule's say-so (FE-165).
 *
 * Always one project: rules are kept per project, so the scope row has no
 * "All projects".
 */
export function PermissionsSection() {
  const project = useSettingsProject();
  if (!project)
    return (
      <SettingsPage
        scope={<SettingsScope />}
        title="Permissions"
        description={DESCRIPTION}
        sections={[
          {
            title: "No project",
            hideTitle: true,
            content: (
              <Nothing
                title="No projects yet"
                description="Add a project to see its permission rules."
              />
            ),
          },
        ]}
      />
    );
  // Keyed by slug: picking another project starts from an empty read.
  return <ProjectPermissions key={project.slug} project={project} />;
}
