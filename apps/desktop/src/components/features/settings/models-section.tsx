import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import {
  AGENT_LABELS,
  type AgentModel,
  type ConversationAgent,
} from "#/../shared/conversation";
import { useModels } from "#/components/shared/conversation/composer.models";
import {
  SettingsCard,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Switch } from "#/components/ui/switch";
import { usePreferences } from "#/stores/preferences";

/** Every CLI a chat runs on, in {@link AGENT_LABELS}' order. */
const AGENTS = Object.keys(AGENT_LABELS) as readonly ConversationAgent[];

/** One group's models: a CLI's, or one OpenCode provider's. */
interface ModelGroup {
  key: string;
  title: string;
  agent: ConversationAgent;
  entries: AgentModel[];
}

/**
 * The picker's models as groups: Claude's and Codex's whole, OpenCode's one
 * per provider, in the order main sorted them (OpenCode Go first for a
 * subscriber). The CLI's mark tells an OpenCode provider from a CLI.
 */
function groupsOf(models: readonly AgentModel[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const agent of AGENTS) {
    const own = models.filter((entry) => entry.agent === agent);
    if (agent !== "opencode") {
      if (own.length)
        out.push({
          key: agent,
          title: AGENT_LABELS[agent],
          agent,
          entries: own,
        });
      continue;
    }
    for (const entry of own) {
      const title = entry.group ?? "Other";
      const key = `opencode:${title}`;
      const last = out.at(-1);
      if (last?.key === key) last.entries.push(entry);
      else out.push({ key, title, agent, entries: [entry] });
    }
  }
  return out;
}

/** `groups` narrowed to the models `query` matches, by name, id or group. */
function matching(groups: ModelGroup[], query: string): ModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.flatMap((group) => {
    if (group.title.toLowerCase().includes(q)) return [group];
    const entries = group.entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q),
    );
    return entries.length ? [{ ...group, entries }] : [];
  });
}

/**
 * The model list: a search, then each group behind a disclosure with a
 * switch for all of it, and a switch per model.
 *
 * Only the first group starts open; a search opens every group it matches.
 */
function ModelList() {
  const models = useModels();
  const hiddenModels = usePreferences((state) => state.hiddenModels);
  const setModelsHidden = usePreferences((state) => state.setModelsHidden);
  const hidden = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const groups = useMemo(() => groupsOf(models), [models]);
  const [query, setQuery] = useState("");
  /** Groups opened or closed by hand, against the default (first open). */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim().length > 0;
  const shown = matching(groups, query);

  const flip = (key: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <SettingsCard className="overflow-hidden">
      <label className="flex h-11 items-center gap-2.5 px-4">
        <HugeiconsIcon
          icon={Search01Icon}
          className="text-muted-foreground size-4 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>
      {shown.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyTitle>{searching ? "No matches" : "No models"}</EmptyTitle>
            <EmptyDescription>
              {searching
                ? `No model matches “${query.trim()}”.`
                : "No CLI lists any model yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        shown.map((group) => {
          const index = groups.findIndex((entry) => entry.key === group.key);
          const open = searching || (index === 0) !== flipped.has(group.key);
          // The whole group's ids, not only the ones the search shows.
          const all =
            groups[index]?.entries.map((entry) => entry.id) ??
            group.entries.map((entry) => entry.id);
          const visible = all.filter((id) => !hidden.has(id)).length;
          return (
            <section key={group.key} aria-label={group.title}>
              <div className="flex h-11 items-center gap-2 pr-4 pl-2.5">
                <button
                  type="button"
                  onClick={() => flip(group.key)}
                  aria-expanded={open}
                  disabled={searching}
                  className="hover:bg-foreground/[0.05] flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left transition-colors disabled:hover:bg-transparent"
                >
                  <HugeiconsIcon
                    icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                    className="text-muted-foreground size-3.5 shrink-0"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <TerminalKindIcon
                    kind={group.agent}
                    className="size-4 shrink-0"
                  />
                  <span className="truncate text-[13px] font-medium">
                    {group.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {visible}/{all.length}
                  </span>
                </button>
                <Switch
                  aria-label={`Show every ${group.title} model`}
                  checked={visible === all.length}
                  onCheckedChange={(checked) => setModelsHidden(all, !checked)}
                />
              </div>
              {open && (
                <ul className="divide-border divide-y pb-1">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      title={entry.id}
                      className="mx-4 flex h-9 items-center gap-3"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {entry.label}
                      </span>
                      {entry.legacy && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          Deprecated
                        </span>
                      )}
                      <Switch
                        size="sm"
                        aria-label={`Show ${entry.label}`}
                        checked={!hidden.has(entry.id)}
                        onCheckedChange={(checked) =>
                          setModelsHidden([entry.id], !checked)
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </SettingsCard>
  );
}

/**
 * Settings → Models: which models the composer's picker offers.
 *
 * Lanework's own list, kept on this machine with the other preferences. A
 * CLI's own picker (OpenCode's model visibility, say) is neither read nor
 * changed. A hidden model still runs a conversation that already uses it.
 */
export function ModelsSection() {
  return (
    <SettingsPage
      title="Models"
      description="Which models the composer's picker offers. A hidden model keeps running the conversations already on it."
      sections={[
        {
          title: "Models",
          hideTitle: true,
          keywords:
            "models model picker show hide visible hidden claude codex opencode provider go search",
          content: <ModelList />,
        },
      ]}
    />
  );
}
