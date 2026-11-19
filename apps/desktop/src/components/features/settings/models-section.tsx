import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
  Search01Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Reorder, useDragControls } from "motion/react";
import { useMemo, useState } from "react";
import type { AgentModel, ConversationAgent } from "#/../shared/conversation";
import {
  arrangeModels,
  modelGroupKey,
  useModels,
} from "#/components/shared/conversation/composer.models";
import { SettingsCard } from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/utils";
import { isModelOffered, usePreferences } from "#/stores/preferences";
import { AddModelDialog } from "./models-section.add";

/** One group's models: a CLI's, or one OpenCode provider's. */
interface ModelGroup {
  key: string;
  title: string;
  entries: AgentModel[];
}

/** `models` by group, each in the user's order (stars are not lifted here). */
function groupsOf(
  models: readonly AgentModel[],
  order: Readonly<Record<string, readonly string[]>>,
): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const entry of arrangeModels(models, order)) {
    const key = modelGroupKey(entry);
    const last = out.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else
      out.push({
        key,
        title: entry.agent === "opencode" ? (entry.group ?? "Other") : "",
        entries: [entry],
      });
  }
  return out;
}

const ICON_BUTTON =
  "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] grid size-6 shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30";

/**
 * One model: a handle to drag it, up and down, its star, its name with its
 * id as a slug, and whether the picker offers it.
 */
function ModelRow({
  entry,
  first,
  last,
  searching,
  favorite,
  shown,
  onMove,
  onFavorite,
  onShown,
}: {
  entry: AgentModel;
  first: boolean;
  last: boolean;
  /** While searching the list is a subset: it is not reordered. */
  searching: boolean;
  favorite: boolean;
  shown: boolean;
  onMove: (step: -1 | 1) => void;
  onFavorite: () => void;
  onShown: (shown: boolean) => void;
}) {
  const drag = useDragControls();
  const removeCustom = usePreferences((state) => state.removeCustomModel);
  return (
    <Reorder.Item
      as="li"
      value={entry.id}
      dragListener={false}
      dragControls={drag}
      className="bg-card relative flex h-10 items-center gap-1.5 px-2.5"
      whileDrag={{ zIndex: 10, boxShadow: "0 6px 20px -6px rgb(0 0 0 / 0.25)" }}
    >
      <button
        type="button"
        aria-label={`Drag ${entry.label}`}
        title="Drag to reorder"
        disabled={searching}
        onPointerDown={(event) => drag.start(event)}
        className={cn(
          ICON_BUTTON,
          "cursor-grab touch-none active:cursor-grabbing",
        )}
      >
        <HugeiconsIcon
          icon={DragDropVerticalIcon}
          className="size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        aria-label={`Move ${entry.label} up`}
        title="Move up"
        disabled={searching || first}
        onClick={() => onMove(-1)}
        className={ICON_BUTTON}
      >
        <HugeiconsIcon
          icon={ArrowUp01Icon}
          className="size-3.5"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        aria-label={`Move ${entry.label} down`}
        title="Move down"
        disabled={searching || last}
        onClick={() => onMove(1)}
        className={ICON_BUTTON}
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="size-3.5"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        aria-label={`${favorite ? "Unstar" : "Star"} ${entry.label}`}
        aria-pressed={favorite}
        title={
          favorite ? "Favourite: first in the picker" : "Add to favourites"
        }
        onClick={onFavorite}
        className={cn(
          ICON_BUTTON,
          favorite && "text-tone-amber hover:text-tone-amber",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          className={cn("size-3.5", favorite && "fill-current")}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
      <span className="ml-1 flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate text-[13px]">{entry.label}</span>
        <span className="text-muted-foreground min-w-0 truncate font-mono text-[12px]">
          {entry.id}
        </span>
      </span>
      {entry.legacy && (
        <span className="text-muted-foreground shrink-0 text-xs">
          Deprecated
        </span>
      )}
      {entry.custom && (
        <>
          <span className="text-muted-foreground shrink-0 text-xs">Custom</span>
          <button
            type="button"
            aria-label={`Remove ${entry.label}`}
            title="Remove this model"
            onClick={() => removeCustom(entry.id)}
            className={ICON_BUTTON}
          >
            <HugeiconsIcon
              icon={Delete02Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        </>
      )}
      <Switch
        size="sm"
        aria-label={`Show ${entry.label} in the picker`}
        checked={shown}
        onCheckedChange={onShown}
      />
    </Reorder.Item>
  );
}

/**
 * One group's rows, dragged or stepped into the user's order, with a
 * header (OpenCode's providers) that folds it and puts its order back.
 */
function GroupList({
  group,
  query,
  open,
  onToggle,
  titled,
}: {
  group: ModelGroup;
  query: string;
  open: boolean;
  onToggle: () => void;
  /** OpenCode's providers have a header; a CLI's one list does not. */
  titled: boolean;
}) {
  const hidden = usePreferences((state) => state.hiddenModels);
  const optedIn = usePreferences((state) => state.shownModels);
  const setModelsShown = usePreferences((state) => state.setModelsShown);
  const favorites = usePreferences((state) => state.favoriteModels);
  const setFavorite = usePreferences((state) => state.setModelFavorite);
  const custom = usePreferences((state) => state.modelOrder[group.key]);
  const setOrder = usePreferences((state) => state.setModelOrder);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const optedSet = useMemo(() => new Set(optedIn), [optedIn]);
  const offered = (entry: AgentModel) =>
    isModelOffered(entry, hiddenSet, optedSet);
  const ids = group.entries.map((entry) => entry.id);
  const q = query.trim().toLowerCase();
  const shown = q
    ? group.entries.filter(
        (entry) =>
          entry.label.toLowerCase().includes(q) ||
          entry.id.toLowerCase().includes(q),
      )
    : group.entries;
  const visible = group.entries.filter(offered).length;

  const move = (id: string, step: -1 | 1) => {
    const at = ids.indexOf(id);
    const to = at + step;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[at], next[to]] = [next[to], next[at]];
    setOrder(group.key, next);
  };

  const reset = custom ? (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setOrder(group.key, null)}
      className="text-muted-foreground h-7 shrink-0 rounded-lg px-2 text-[12px]"
    >
      Reset order
    </Button>
  ) : null;

  return (
    <section aria-label={group.title || "Models"}>
      {titled ? (
        <div className="flex h-11 items-center gap-2 pr-4 pl-2.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            disabled={Boolean(q)}
            className="hover:bg-foreground/[0.05] flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left transition-colors disabled:hover:bg-transparent"
          >
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              className="text-muted-foreground size-3.5 shrink-0"
              strokeWidth={2}
              aria-hidden="true"
            />
            <span className="truncate text-[13px] font-medium">
              {group.title}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {visible}/{ids.length}
            </span>
          </button>
          {reset}
          <Switch
            aria-label={`Show every ${group.title} model`}
            checked={visible === ids.length}
            onCheckedChange={(checked) =>
              setModelsShown(group.entries, checked)
            }
          />
        </div>
      ) : (
        reset && <div className="flex justify-end px-2.5 pt-1.5">{reset}</div>
      )}
      {open && (
        <Reorder.Group
          as="ul"
          axis="y"
          values={ids}
          onReorder={(next) => setOrder(group.key, next)}
          className="divide-border divide-y pb-1"
        >
          {shown.map((entry) => (
            <ModelRow
              key={entry.id}
              entry={entry}
              first={entry.id === ids[0]}
              last={entry.id === ids[ids.length - 1]}
              searching={Boolean(q)}
              favorite={favorites.includes(entry.id)}
              shown={offered(entry)}
              onMove={(step) => move(entry.id, step)}
              onFavorite={() =>
                setFavorite(entry.id, !favorites.includes(entry.id))
              }
              onShown={(on) => setModelsShown([entry], on)}
            />
          ))}
        </Reorder.Group>
      )}
    </section>
  );
}

/**
 * A CLI's models in Settings → Harness → <CLI> (FE-146): which the composer's
 * picker offers, which are starred (first in it, and its Favourites) and in
 * what order. OpenCode's are one group per provider, each folding and
 * reordered on its own; the first starts open.
 *
 * Lanework's own list, kept on this machine. A CLI's own picker is neither
 * read nor changed, and a hidden model still runs the chats already on it.
 */
export function HarnessModels({ agent }: { agent: ConversationAgent }) {
  const all = useModels();
  const order = usePreferences((state) => state.modelOrder);
  const groups = useMemo(
    () =>
      groupsOf(
        all.filter((entry) => entry.agent === agent),
        order,
      ),
    [all, agent, order],
  );
  const [query, setQuery] = useState("");
  /** Groups opened or closed by hand, against the default (first open). */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const hidden = usePreferences((state) => state.hiddenModels);
  const optedIn = usePreferences((state) => state.shownModels);
  const setModelsShown = usePreferences((state) => state.setModelsShown);
  const [adding, setAdding] = useState(false);
  const allEntries = groups.flatMap((group) => group.entries);
  // "Disable all" while any is offered; once every one is hidden, "Enable".
  const noneHidden = allEntries.some((entry) =>
    isModelOffered(entry, hidden, optedIn),
  );
  const titled = agent === "opencode";
  const q = query.trim().toLowerCase();
  const matching = groups.filter(
    (group) =>
      !q ||
      group.title.toLowerCase().includes(q) ||
      group.entries.some(
        (entry) =>
          entry.label.toLowerCase().includes(q) ||
          entry.id.toLowerCase().includes(q),
      ),
  );

  return (
    <SettingsCard className="overflow-hidden">
      {/* The list's header: a search, then the whole CLI shown or hidden at
          once, and a model of the user's own (FE-146). */}
      <div className="flex h-11 items-center gap-2 pr-2.5 pl-4">
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
        {count > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setModelsShown(allEntries, !noneHidden)}
            className="text-muted-foreground h-7 shrink-0 rounded-lg px-2 text-[12px]"
          >
            {noneHidden ? "Disable all" : "Enable all"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAdding(true)}
          className="h-7 shrink-0 gap-1 rounded-lg px-2 text-[12px]"
        >
          <HugeiconsIcon
            icon={Add01Icon}
            strokeWidth={2}
            data-icon="inline-start"
            aria-hidden="true"
          />
          Add model
        </Button>
      </div>
      <AddModelDialog agent={agent} open={adding} onOpenChange={setAdding} />
      {matching.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyTitle>{q ? "No matches" : "No models"}</EmptyTitle>
            <EmptyDescription>
              {q
                ? `No model matches “${query.trim()}”.`
                : "This CLI lists no model yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        matching.map((group, index) => (
          <GroupList
            key={group.key}
            group={group}
            query={q && group.title.toLowerCase().includes(q) ? "" : query}
            titled={titled}
            open={
              !titled || Boolean(q) || (index === 0) !== flipped.has(group.key)
            }
            onToggle={() =>
              setFlipped((current) => {
                const next = new Set(current);
                if (!next.delete(group.key)) next.add(group.key);
                return next;
              })
            }
          />
        ))
      )}
    </SettingsCard>
  );
}
