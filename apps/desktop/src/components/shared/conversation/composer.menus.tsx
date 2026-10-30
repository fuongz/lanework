import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import {
  Add01Icon,
  ArrowDown01Icon,
  FileAddIcon,
  FlashIcon,
  PencilEdit02Icon,
  Search01Icon,
  SecurityWarningIcon,
  Settings01Icon,
  SparklesIcon,
  SquareLock02Icon,
  StarIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useMemo, useState } from "react";
import {
  AGENT_LABELS,
  type AgentModel,
  agentOfModel,
  type ComposerSettings,
  type ConversationAgent,
  EFFORT_LABELS,
  EFFORTS,
  type Effort,
  modelName,
  PERMISSION_COPY,
  PERMISSIONS,
  type Permission,
} from "#/../shared/conversation";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Switch } from "#/components/ui/switch";
import { readStored, writeStored } from "#/lib/stored";
import { cn } from "#/lib/utils";
import { usePreferences } from "#/stores/preferences";
import { useModels } from "./composer.models";

/** A pill in the composer's bottom row. */
const PILL =
  "text-foreground hover:bg-foreground/[0.08] aria-expanded:bg-foreground/[0.08] bg-foreground/[0.05] flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";

const FAVORITES_KEY = "lanework.conversation.favorite-models";

function readFavorites(): string[] {
  try {
    const raw = readStored(FAVORITES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]) {
  // A favourite that is not kept is only a convenience lost.
  writeStored(FAVORITES_KEY, JSON.stringify(ids));
}

/** Every CLI a chat runs on, in {@link AGENT_LABELS}' order: one tab each. */
const AGENTS = Object.keys(AGENT_LABELS) as readonly ConversationAgent[];

/** Excludes nothing; one array, so the panel's memo holds. */
const NO_AGENTS: readonly ConversationAgent[] = [];

/**
 * The model panel: favourites, a tab per CLI, and a search over its models.
 *
 * A narrow column: favourites, then one tab each for Claude, Codex and
 * OpenCode, the tab's legacy models after a divider. `agent` locks it to one
 * CLI's models, because a conversation stays on the CLI that wrote it.
 *
 * NOTE: OpenCode's models are the providers the user set up in OpenCode, read
 * by main (FE-104). With none, its tab says how to get some rather than
 * offering a model that would not run.
 */
function ModelPanel({
  model,
  agent,
  exclude = NO_AGENTS,
  onPick,
}: {
  model: string;
  agent: ConversationAgent | null;
  exclude?: readonly ConversationAgent[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<ConversationAgent | "favorites">(
    () => agent ?? agentOfModel(model),
  );
  const tabs = agent ? [agent] : AGENTS.filter((tab) => !exclude.includes(tab));
  const navigate = useNavigate();
  const all = useModels();
  const hiddenModels = usePreferences((state) => state.hiddenModels);
  const models = useMemo(
    () => all.filter((entry) => !exclude.includes(entry.agent)),
    [all, exclude],
  );
  // Settings → Models hides a model from here; the one picked stays, so the
  // tick still says what runs.
  const hidden = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const [favorites, setFavorites] = useState(readFavorites);
  const toggle = (id: string) => {
    const next = favorites.includes(id)
      ? favorites.filter((entry) => entry !== id)
      : [...favorites, id];
    setFavorites(next);
    writeFavorites(next);
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter(
      (entry) =>
        (!hidden.has(entry.id) || entry.id === model) &&
        (!agent || entry.agent === agent) &&
        (only === "favorites"
          ? favorites.includes(entry.id)
          : entry.agent === only) &&
        (!q ||
          entry.label.toLowerCase().includes(q) ||
          entry.id.includes(q) ||
          (entry.group?.toLowerCase().includes(q) ?? false)),
    );
  }, [query, only, favorites, agent, models, hidden, model]);
  // OpenCode's tab with no models at all: none configured, not no match.
  const noOpenCode =
    only === "opencode" &&
    !query.trim() &&
    !models.some((entry) => entry.agent === "opencode");
  // A tab whose every model is hidden: say where they went.
  const allHidden =
    !noOpenCode &&
    only !== "favorites" &&
    !query.trim() &&
    shown.length === 0 &&
    models.some((entry) => entry.agent === only);
  // OpenCode's come grouped by provider (FE-104): headed runs, in main's
  // order, each with its own deprecated ones last. The others keep the
  // divider before their legacy models.
  const grouped = shown.some((entry) => entry.group);
  const current = shown.filter((entry) => !entry.legacy);
  const legacy = shown.filter((entry) => entry.legacy);
  const runs = grouped
    ? shown.reduce<{ group: string | null; entries: AgentModel[] }[]>(
        (out, entry) => {
          const group = entry.group ?? null;
          const last = out.at(-1);
          if (last && last.group === group) last.entries.push(entry);
          else out.push({ group, entries: [entry] });
          return out;
        },
        [],
      )
    : [];

  const row = (entry: AgentModel) => (
    <DropdownMenuItem
      key={entry.id}
      onClick={() => onPick(entry.id)}
      className="group/model h-9 gap-2 rounded-lg px-2.5 text-[13px]"
    >
      {only === "favorites" && (
        <TerminalKindIcon kind={entry.agent} className="size-3.5 shrink-0" />
      )}
      <span className="flex-1 truncate">{entry.label}</span>
      {entry.preferred && (
        <span className="text-muted-foreground shrink-0 text-[12px]">
          Default
        </span>
      )}
      <button
        type="button"
        aria-label={
          favorites.includes(entry.id)
            ? `Remove ${entry.label} from favorites`
            : `Add ${entry.label} to favorites`
        }
        aria-pressed={favorites.includes(entry.id)}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          toggle(entry.id);
        }}
        className={cn(
          "hover:text-tone-amber flex size-5 items-center justify-center rounded transition-opacity",
          favorites.includes(entry.id)
            ? "text-tone-amber"
            : "text-muted-foreground opacity-0 group-hover/model:opacity-100 group-data-highlighted/model:opacity-100",
        )}
      >
        <HugeiconsIcon icon={StarIcon} className="size-3.5" strokeWidth={1.8} />
      </button>
      <HugeiconsIcon
        icon={Tick02Icon}
        className={cn("size-4", entry.id === model ? "" : "invisible")}
        strokeWidth={2}
        aria-hidden="true"
      />
    </DropdownMenuItem>
  );

  return (
    <div className="flex h-[min(26rem,var(--available-height))] w-[22rem]">
      <div className="border-foreground/10 flex w-11 shrink-0 flex-col items-center gap-1 border-r py-1">
        <button
          type="button"
          aria-label="Favorite models"
          aria-pressed={only === "favorites"}
          onClick={() => setOnly("favorites")}
          className="text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors"
        >
          <HugeiconsIcon icon={StarIcon} className="size-4" strokeWidth={1.8} />
        </button>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-label={`${AGENT_LABELS[tab]} models`}
            title={AGENT_LABELS[tab]}
            aria-pressed={only === tab}
            onClick={() => setOnly(tab)}
            className="aria-pressed:bg-foreground/10 hover:bg-foreground/[0.06] flex size-8 items-center justify-center rounded-lg transition-colors"
          >
            <TerminalKindIcon kind={tab} className="size-4" />
          </button>
        ))}
        {/* An item, so picking it closes the menu on its way to Settings. */}
        <DropdownMenuItem
          aria-label="Manage models"
          title="Manage models"
          onClick={() => void navigate({ to: "/settings/models" })}
          className="text-muted-foreground hover:text-foreground mt-auto flex size-8 items-center justify-center rounded-lg p-0"
        >
          <HugeiconsIcon
            icon={Settings01Icon}
            className="size-4"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </DropdownMenuItem>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <label className="border-foreground/10 flex h-10 shrink-0 items-center gap-2 border-b px-2.5">
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            // NOTE: The menu reads keys for its own typeahead: a letter typed
            // here is the search's, and only the arrows and Escape move on.
            onKeyDown={(event) => {
              if (
                !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)
              )
                event.stopPropagation();
            }}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {grouped ? (
            runs.map((run) => (
              <DropdownMenuGroup key={run.entries[0]?.id}>
                {run.group && (
                  <DropdownMenuLabel
                    // The group being scrolled through stays named on top. No
                    // fill of its own, so it is the panel's colour; the blur
                    // keeps the rows passing under it from showing through.
                    className="sticky -top-1 z-10 -mx-1 px-3.5 pt-2.5 pb-1 text-[12px] backdrop-blur-3xl"
                  >
                    {run.group}
                  </DropdownMenuLabel>
                )}
                {run.entries.map(row)}
              </DropdownMenuGroup>
            ))
          ) : (
            <>
              {current.map(row)}
              {current.length > 0 && legacy.length > 0 && (
                <div
                  aria-hidden="true"
                  className="bg-foreground/10 mx-2 my-1 h-px"
                />
              )}
              {legacy.map(row)}
            </>
          )}
          {shown.length === 0 && (
            <Empty className="px-2.5 py-4">
              <EmptyHeader>
                <EmptyTitle>
                  {noOpenCode
                    ? "No OpenCode models"
                    : allHidden
                      ? `Every ${AGENT_LABELS[only as ConversationAgent]} model is hidden`
                      : only === "favorites" && !query
                        ? "No favorites yet"
                        : "No matches"}
                </EmptyTitle>
                <EmptyDescription>
                  {noOpenCode
                    ? "Configure a provider in OpenCode, then open this menu again."
                    : allHidden
                      ? "Show them again with Manage models, the gear below the tabs."
                      : only === "favorites" && !query
                        ? "Star a model to keep it here."
                        : "No model matches."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The model pill and its menu: Fast, the effort slider, Model ›.
 *
 * The pill's mark is the model's CLI.
 */
export function ModelMenu({
  settings,
  agent = null,
  exclude,
  onChange,
  disabled,
  side = "top",
  fast = true,
  auto,
  effortSet = true,
  ghost = false,
  className,
}: {
  settings: ComposerSettings;
  /** Only this CLI's models; null offers every CLI's. */
  agent?: ConversationAgent | null;
  /** CLIs whose models it never offers: a conductor's lead is never OpenCode (FE-105/D5). */
  exclude?: readonly ConversationAgent[];
  onChange: (next: Partial<ComposerSettings>) => void;
  disabled?: boolean;
  /** Where the menu opens: above the composer, below a settings row. */
  side?: "top" | "bottom";
  /** Offer Fast; off where it is not kept (a conductor, FE-95). */
  fast?: boolean;
  /**
   * An "Auto (by tier)" entry, for a proposal's task: `active` when no
   * model is named and the run picks one by tier.
   */
  auto?: { active: boolean; onPick: () => void };
  /** False while the effort is the default: the pill says so. */
  effortSet?: boolean;
  /** No fill until hovered: for a row in a list, not a composer's bar. */
  ghost?: boolean;
  className?: string;
}) {
  // Re-drawn when Codex's or OpenCode's list arrives: labels come with it.
  useModels();
  const automatic = auto?.active ?? false;
  // OpenCode has no model until its list is read (FE-104): "" until then.
  const name = automatic
    ? "Auto"
    : (modelName(settings.model) ?? (settings.model || "No model"));
  // A locked CLI's mark, even for a model its list has not named yet.
  const kind = agent ?? agentOfModel(settings.model);
  const effortLabel = effortSet ? EFFORT_LABELS[settings.effort] : "Default";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Model: ${name}, effort ${effortLabel}${settings.fast ? ", fast" : ""}`}
        className={cn(PILL, ghost && "bg-transparent", className)}
      >
        {!automatic && <TerminalKindIcon kind={kind} className="size-3.5" />}
        <span>{name}</span>
        <span className="text-muted-foreground">{effortLabel}</span>
        {settings.fast && (
          <HugeiconsIcon
            icon={FlashIcon}
            className="text-tone-amber size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="text-muted-foreground size-3.5"
          strokeWidth={2}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={side === "top" ? "start" : "end"}
        sideOffset={6}
        className="w-72 p-1.5"
      >
        {/* OpenCode has no fast mode: its engine ignores it (FE-104). */}
        {fast && kind !== "opencode" && (
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => onChange({ fast: !settings.fast })}
            className="h-9 rounded-lg px-2.5 text-[13px]"
          >
            <span className="flex-1">Fast</span>
            <Switch
              checked={settings.fast}
              tabIndex={-1}
              aria-hidden="true"
              className="pointer-events-none"
            />
          </DropdownMenuItem>
        )}
        <EffortSlider
          effort={settings.effort}
          onChange={(effort) => onChange({ effort })}
        />
        {auto && (
          <DropdownMenuItem
            onClick={auto.onPick}
            className={cn(
              "h-9 rounded-lg px-2.5 text-[13px]",
              automatic && "bg-foreground/[0.08]",
            )}
          >
            <span className="flex-1">Auto (by tier)</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-lg px-2.5 text-[13px]">
            <span className="shrink-0">Model</span>
            {/* One line however long the name: OpenCode's run long. */}
            <span className="text-muted-foreground ml-auto flex min-w-0 items-center gap-1.5">
              <TerminalKindIcon kind={kind} className="size-3.5 shrink-0" />
              <span className="truncate">{name}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="overflow-hidden p-0"
            sideOffset={6}
          >
            <ModelPanel
              model={settings.model}
              agent={agent}
              exclude={exclude}
              onPick={(model) => onChange({ model })}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The thumb's width, in px: the slider's steps are laid out around it. */
const THUMB = 10;

/**
 * From cool to hot: the higher the effort, the further the warmth reaches.
 *
 * Fixed rather than the `--tone-*` tokens: those are toned down per theme
 * for text, and a fill this size wants its full colour in both.
 */
const EFFORT_GRADIENT =
  "linear-gradient(90deg, oklch(0.95 0.015 230), oklch(0.84 0.1 225) 30%, oklch(0.74 0.14 240) 48%, oklch(0.86 0.16 88) 72%, oklch(0.76 0.17 58))";

/**
 * How the thumb and fill settle on a step: quick out, soft landing. Off while
 * dragging, where they follow the pointer instead.
 */
const SETTLE =
  "duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[dragging]/effort:duration-0 motion-reduce:duration-0";

/**
 * Effort as a slider: a track that fills with the gradient up to the thumb,
 * and a dot for each step still above it.
 *
 * - A drag follows the pointer freely, not step by step, and the thumb
 *   glides to the nearest step on release. Only then does the effort change.
 * - The arrow keys, Home and End move one step at a time, taken here before
 *   the slider sees them (its own step is a fine one, for the drag), and
 *   kept from the menu, whose highlight they would move.
 */
function EffortSlider({
  effort,
  onChange,
}: {
  effort: Effort;
  onChange: (effort: Effort) => void;
}) {
  const at = EFFORTS.indexOf(effort);
  const last = EFFORTS.length - 1;
  // Where the thumb is while dragging; null when it rests on `effort`.
  const [drag, setDrag] = useState<number | null>(null);
  const position = drag ?? at;
  const shown = EFFORTS[Math.round(position)] ?? effort;

  function settle(value: number) {
    setDrag(null);
    const next = EFFORTS[Math.round(value)];
    if (next && next !== effort) onChange(next);
  }

  function onKeyDownCapture(event: KeyboardEvent) {
    const step: Record<string, number> = {
      ArrowLeft: at - 1,
      ArrowDown: at - 1,
      ArrowRight: at + 1,
      ArrowUp: at + 1,
      Home: 0,
      End: last,
    };
    const to = step[event.key];
    if (to === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    settle(Math.min(last, Math.max(0, to)));
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only steers the slider's and the menu's keys; the slider inside is the control
    <div
      className="flex flex-col gap-2 px-2.5 pt-2 pb-2.5"
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center text-[13px]">
        <span className="flex-1">Effort</span>
        <span className="text-muted-foreground tabular-nums">
          {EFFORT_LABELS[shown]}
        </span>
      </div>
      <SliderPrimitive.Root
        className="group/effort"
        value={position}
        min={0}
        max={last}
        step={0.001}
        thumbAlignment="edge"
        onValueChange={(value) => setDrag(value as number)}
        onValueCommitted={(value) => settle(value as number)}
      >
        <SliderPrimitive.Control className="relative flex h-7 w-full cursor-pointer touch-none items-center select-none">
          <SliderPrimitive.Track className="bg-foreground/[0.08] @container relative h-full w-full overflow-hidden rounded-full">
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width]",
                SETTLE,
              )}
              style={{
                width: `calc((100% - ${THUMB}px) * ${position / last} + ${THUMB}px)`,
              }}
            >
              {/* As wide as the track, so the gradient's colours stay put
                  and the fill only reveals more of them. */}
              <div
                className="absolute inset-y-0 left-0 w-[100cqw]"
                style={{ backgroundImage: EFFORT_GRADIENT }}
              />
            </div>
            {EFFORTS.map((step, i) => (
              <span
                key={step}
                aria-hidden="true"
                className="bg-foreground/25 absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  left: `calc((100% - ${THUMB}px) * ${i / last} + ${THUMB / 2}px)`,
                  opacity: i > position + 0.15 ? 1 : 0,
                  scale: i > position + 0.15 ? 1 : 0.4,
                }}
              />
            ))}
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label="Effort"
            getAriaValueText={() => EFFORT_LABELS[shown]}
            className={cn(
              "focus-visible:ring-ring/40 block h-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 outline-none transition-[left,inset-inline-start,scale] focus-visible:ring-2 group-data-[dragging]/effort:scale-y-110",
              SETTLE,
            )}
            style={{ width: THUMB }}
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
    </div>
  );
}

const PERMISSION_ICONS: Record<Permission, IconSvgElement> = {
  manual: SquareLock02Icon,
  acceptEdits: PencilEdit02Icon,
  auto: SparklesIcon,
  bypassPermissions: SecurityWarningIcon,
};

function PermissionIcon({
  permission,
  className,
}: {
  permission: Permission;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={PERMISSION_ICONS[permission]}
      className={cn(
        "size-4 shrink-0",
        permission === "bypassPermissions" && "text-tone-amber",
        className,
      )}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

/** The permission pill and its menu: the same four modes for both CLIs. */
export function PermissionMenu({
  permission,
  onChange,
  disabled,
  side = "top",
}: {
  permission: Permission;
  onChange: (permission: Permission) => void;
  disabled?: boolean;
  /** Where the menu opens: above the composer, below a settings row. */
  side?: "top" | "bottom";
}) {
  const copy = PERMISSION_COPY;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Permissions: ${copy[permission].label}`}
        className={PILL}
      >
        <PermissionIcon permission={permission} className="size-3.5" />
        <span>{copy[permission].label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className="text-muted-foreground size-3.5"
          strokeWidth={2}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={side === "top" ? "start" : "end"}
        sideOffset={6}
        // A gap between the rows: the picked one is tinted, and so is the one
        // under the pointer. Touching, the two would read as one block.
        className="flex w-[22rem] flex-col gap-1 p-1.5"
      >
        {PERMISSIONS.map((entry) => (
          <DropdownMenuItem
            key={entry}
            onClick={() => onChange(entry)}
            className={cn(
              "items-start gap-3 rounded-lg px-3 py-2.5",
              entry === permission && "bg-foreground/[0.08]",
            )}
          >
            <PermissionIcon permission={entry} className="mt-0.5" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium">
                {copy[entry].label}
              </span>
              <span className="text-muted-foreground text-xs leading-snug">
                {copy[entry].description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The composer's +: what can be added to the message.
 *
 * Upload file is the only entry; the menu is where the next ones go.
 */
export function AttachMenu({
  onUpload,
  disabled,
}: {
  onUpload: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Add to message"
        className="text-muted-foreground hover:text-foreground bg-foreground/[0.05] hover:bg-foreground/[0.08] aria-expanded:bg-foreground/[0.08] aria-expanded:text-foreground focus-visible:ring-ring/30 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2"
      >
        <HugeiconsIcon icon={Add01Icon} className="size-4" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="flex w-[17rem] flex-col gap-1 p-1.5"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 pt-1.5 pb-1 text-[11px] font-medium tracking-wide uppercase">
            Add to message
          </DropdownMenuLabel>
          <DropdownMenuItem
            onClick={onUpload}
            className="items-start gap-3 rounded-lg px-3 py-2.5"
          >
            <HugeiconsIcon
              icon={FileAddIcon}
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium">Upload file</span>
              <span className="text-muted-foreground text-xs leading-snug">
                Attach files or images
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
