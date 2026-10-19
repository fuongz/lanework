import {
  Add01Icon,
  ArrowDown01Icon,
  FileAddIcon,
  FlashIcon,
  PencilEdit02Icon,
  Search01Icon,
  SecurityWarningIcon,
  SparklesIcon,
  SquareLock02Icon,
  StarIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMemo, useState } from "react";
import {
  AGENT_LABELS,
  type AgentModel,
  agentOfModel,
  type ComposerSettings,
  type ConversationAgent,
  EFFORT_LABELS,
  EFFORTS,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { cn } from "#/lib/utils";
import { useModels } from "./use-models";

/** A pill in the composer's bottom row (ảnh 7). */
const PILL =
  "text-foreground hover:bg-foreground/[0.08] aria-expanded:bg-foreground/[0.08] bg-foreground/[0.05] flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";

const FAVORITES_KEY = "lanework.conversation.favorite-models";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    /* A favourite that is not kept is only a convenience lost. */
  }
}

const AGENTS: readonly ConversationAgent[] = ["claude", "codex"];

/**
 * The model panel (ảnh 8): a narrow column — favourites, then one tab per
 * CLI, Claude and Codex — and a search over that tab's models, the legacy
 * ones after a divider. `agent` locks it to one CLI's: a conversation stays
 * on the CLI that wrote it.
 */
function ModelPanel({
  model,
  agent,
  onPick,
}: {
  model: string;
  agent: ConversationAgent | null;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<ConversationAgent | "favorites">(
    () => agent ?? agentOfModel(model),
  );
  const tabs = agent ? [agent] : AGENTS;
  const models = useModels();
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
        (!agent || entry.agent === agent) &&
        (only === "favorites"
          ? favorites.includes(entry.id)
          : entry.agent === only) &&
        (!q || entry.label.toLowerCase().includes(q) || entry.id.includes(q)),
    );
  }, [query, only, favorites, agent, models]);
  const current = shown.filter((entry) => !entry.legacy);
  const legacy = shown.filter((entry) => entry.legacy);

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
    <div className="flex h-[min(26rem,var(--available-height))] w-[19rem]">
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
            // ⚠️ The menu reads keys for its own typeahead: a letter typed
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
          {current.map(row)}
          {current.length > 0 && legacy.length > 0 && (
            <div
              aria-hidden="true"
              className="bg-foreground/10 mx-2 my-1 h-px"
            />
          )}
          {legacy.map(row)}
          {shown.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-3 text-xs">
              {only === "favorites" && !query
                ? "No favorites yet. Star a model to keep it here."
                : "No model matches."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The model pill and its menu (D9, ảnh 7–8): Fast, Effort ›, Model ›. The
 * mark is the model's CLI.
 */
export function ModelMenu({
  settings,
  agent = null,
  onChange,
  disabled,
}: {
  settings: ComposerSettings;
  /** Only this CLI's models; null offers both. */
  agent?: ConversationAgent | null;
  onChange: (next: Partial<ComposerSettings>) => void;
  disabled?: boolean;
}) {
  // Re-drawn when Codex's list arrives: its labels come with it.
  useModels();
  const name = modelName(settings.model) ?? settings.model;
  const kind = agentOfModel(settings.model);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Model: ${name}, effort ${EFFORT_LABELS[settings.effort]}${settings.fast ? ", fast" : ""}`}
        className={PILL}
      >
        <TerminalKindIcon kind={kind} className="size-3.5" />
        <span>{name}</span>
        <span className="text-muted-foreground">
          {EFFORT_LABELS[settings.effort]}
        </span>
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
        side="top"
        align="start"
        sideOffset={6}
        className="w-60 p-1.5"
      >
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-lg px-2.5 text-[13px]">
            <span className="flex-1">Effort</span>
            <span className="text-muted-foreground">
              {EFFORT_LABELS[settings.effort]}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44 p-1.5" sideOffset={6}>
            <DropdownMenuRadioGroup
              value={settings.effort}
              onValueChange={(value) =>
                onChange({ effort: value as ComposerSettings["effort"] })
              }
            >
              {EFFORTS.map((effort) => (
                <DropdownMenuRadioItem
                  key={effort}
                  value={effort}
                  className="h-9 rounded-lg px-2.5 text-[13px]"
                >
                  {EFFORT_LABELS[effort]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="h-9 rounded-lg px-2.5 text-[13px]">
            <span className="flex-1">Model</span>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <TerminalKindIcon kind={kind} className="size-3.5" />
              {name}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="overflow-hidden p-0"
            sideOffset={6}
          >
            <ModelPanel
              model={settings.model}
              agent={agent}
              onPick={(model) => onChange({ model })}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
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

/** The permission pill and its menu (D9, ảnh 9): the same four for both CLIs. */
export function PermissionMenu({
  permission,
  onChange,
  disabled,
}: {
  permission: Permission;
  onChange: (permission: Permission) => void;
  disabled?: boolean;
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
        side="top"
        align="start"
        sideOffset={6}
        // ⚠️ A gap between the rows: the picked one is tinted, and so is the
        // one under the pointer — touching, the two read as one block.
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
 * The composer's + (ảnh 6): what can be added to the message. Upload file is
 * the only entry for now; the menu is where the next ones go.
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
