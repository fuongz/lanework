import {
  Add01Icon,
  Search01Icon,
  Settings01Icon,
  Sorting05Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { TerminalSession } from "#/../shared/terminal";
import type { Workspace } from "#/../shared/workspaces";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { CreateProjectDialog } from "#/components/shared/common/create-project-dialog";
import { ProjectTile } from "#/components/shared/common/project-tile";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import { NO_CHATS, useChatEngines } from "#/stores/chat-engines";
import { useOpenProject } from "#/stores/last-route";
import { type ProjectSort, usePreferences } from "#/stores/preferences";
import { isLocalWorkspace } from "#/stores/session";

/** The terminal key a project's agents are filed under (FE-19, FE-26). */
const keyOf = (workspace: Workspace) => workspace.id ?? workspace.slug;

const NO_AGENTS: TerminalSession[] = [];

/** Lower case, accents off: `Đơn` finds `don`, `Hiip` finds `hiip`. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

/** One running agent: a live agent tab, or a chat whose engine is alive. */
type RunningAgent = Pick<TerminalSession, "id" | "kind">;

/**
 * The agents running in a project on this machine, as overlapping marks.
 *
 * ⚠️ Capped at three with the rest counted, like `AvatarStack`: a project with
 * five agents going says five, not three and silence.
 */
function RunningAgents({ agents }: { agents: RunningAgent[] }) {
  if (agents.length === 0) return null;
  const shown = agents.slice(0, 3);
  const rest = agents.length - shown.length;
  const names = agents
    .map((agent) => TERMINAL_KIND_LABELS[agent.kind])
    .join(", ");
  return (
    <span
      className="ml-auto flex shrink-0 items-center pr-1 pl-2"
      title={names}
    >
      {shown.map((agent) => (
        <span
          key={agent.id}
          className="bg-muted ring-popover -mr-1.5 grid size-5 place-items-center rounded-full ring-2 last:mr-0"
        >
          <TerminalKindIcon kind={agent.kind} className="size-3" />
        </span>
      ))}
      {rest > 0 && (
        <span className="text-muted-foreground ml-1.5 text-[11px] tabular-nums">
          +{rest}
        </span>
      )}
      <span className="sr-only">
        {`, ${agents.length} ${agents.length === 1 ? "agent" : "agents"} running: ${names}`}
      </span>
    </span>
  );
}

/**
 * The project this window is looking at, and the way to any other one.
 *
 * ⚠️ This replaces the old "Change workspace" screen entirely. Choosing a
 * project is navigation, not a page: it belongs in the same place every time,
 * at the top of the rail, rather than behind a button that only appears when a
 * board is already open.
 */
/**
 * `compact`: the mini rail's form (FE-58) — the project's tile alone, its
 * list opening to the side instead of below.
 */
export function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sort = usePreferences((state) => state.projectSort);
  const setSort = usePreferences((state) => state.setProjectSort);
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const openProject = useOpenProject();
  const navigate = useNavigate();
  const agentsByKey = useAgentTerminals((state) => state.sessions);
  const refreshAgents = useAgentTerminals((state) => state.refresh);
  const chatsByKey = useChatEngines((state) => state.alive);
  const refreshChats = useChatEngines((state) => state.refresh);
  /**
   * A project's running agents: its live agent tabs, then the conversations
   * the chat runs (FE-62).
   *
   * ⚠️ The chats count too. "New Claude" opens a chat now, so a project whose
   * Claude runs there has no agent tab at all — counting tabs alone left its
   * row blank while the rail listed it under Running.
   */
  const runningIn = (workspace: Workspace): RunningAgent[] => {
    const tabs = (agentsByKey[keyOf(workspace)] ?? NO_AGENTS).filter(
      (agent) => !agent.exit,
    );
    const chats = (chatsByKey[keyOf(workspace)] ?? NO_CHATS)
      .filter((id) => !tabs.some((tab) => tab.resume === id))
      .map((id): RunningAgent => ({ id, kind: "claude" }));
    return [...tabs, ...chats];
  };
  const hasAgents = (workspace: Workspace) => runningIn(workspace).length > 0;
  const sortedWorkspaces =
    sort === "default"
      ? workspaces
      : [...workspaces].sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            : Number(hasAgents(b)) - Number(hasAgents(a)),
        );

  // By name or slug. ⌘1…⌘9 keep the whole list's order, whatever is typed.
  const needle = fold(query.trim());
  const shownWorkspaces = needle
    ? sortedWorkspaces.filter(
        (workspace) =>
          fold(workspace.name).includes(needle) ||
          fold(workspace.slug).includes(needle),
      )
    : sortedWorkspaces;

  // ⚠️ Asked for EVERY project each time the menu opens. The rail only lists
  // the open project's agents, so without this the other rows would show
  // whatever was running the last time each one was open — or nothing.
  useEffect(() => {
    if (!open) return;
    for (const workspace of workspaces) {
      void refreshAgents(keyOf(workspace));
      void refreshChats(keyOf(workspace));
    }
  }, [open, workspaces, refreshAgents, refreshChats]);

  const go = (slug: string) => {
    setOpen(false);
    setCreating(false);
    openProject(slug);
  };

  /**
   * ⌘1…⌘9 open a project, in the menu's order.
   *
   * The menu no longer prints them beside each row — the list reads cleaner
   * without — but the keys still work for whoever knows them.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const at = Number(event.key) - 1;
      if (!Number.isInteger(at) || at < 0 || at > 8) return;
      const workspace = sortedWorkspaces[at];
      if (!workspace) return;
      event.preventDefault();
      go(workspace.slug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Each opening starts from the whole list.
          if (next) setQuery("");
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              // ⚠️ Named for what it DOES, with the current project inside the
              // name. A button whose accessible name is only "Lanework" tells a
              // screen-reader user what they are looking at and nothing about
              // what pressing it would do.
              aria-label={`Switch project — currently ${active?.name ?? "none"}`}
              title={compact ? (active?.name ?? "Choose a project") : undefined}
              className={
                compact
                  ? "hover:bg-foreground/[0.05] grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150"
                  : "hover:bg-foreground/[0.05] flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-150"
              }
            >
              <ProjectTile workspace={active} className="size-6 text-[11px]" />
              {!compact && (
                <>
                  <span className="truncate text-[13px] font-medium">
                    {active?.name ?? "Choose a project"}
                  </span>
                  <HugeiconsIcon
                    icon={UnfoldMoreIcon}
                    className="text-muted-foreground ml-auto size-3.5 shrink-0"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </>
              )}
            </button>
          }
        />
        <PopoverContent
          variant="menu"
          align="start"
          side={compact ? "right" : undefined}
          initialFocus={search}
          // ⚠️ A set width: as wide as its rows, it would narrow with every
          // letter typed.
          className="w-72 p-1"
        >
          {workspaces.length > 0 && (
            <div className="border-foreground/10 mb-1 flex h-8 shrink-0 items-center gap-2 border-b px-2 pb-1">
              <HugeiconsIcon
                icon={Search01Icon}
                className="text-muted-foreground size-3.5 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <input
                ref={search}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && shownWorkspaces[0]) {
                    event.preventDefault();
                    go(shownWorkspaces[0].slug);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    list.current
                      ?.querySelector<HTMLButtonElement>("[role=option]")
                      ?.focus();
                  }
                }}
                placeholder="Search projects"
                aria-label="Search projects"
                autoComplete="off"
                spellCheck={false}
                className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </div>
          )}
          <RailHover className="max-h-80 overflow-y-auto">
            <div
              ref={list}
              role="listbox"
              aria-label="Projects"
              className="flex flex-col gap-0.5"
              onKeyDown={(event) => {
                // ↑ ↓ walk the rows; ↑ from the first goes back to the search.
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  return;
                const rows = [
                  ...(list.current?.querySelectorAll<HTMLButtonElement>(
                    "[role=option]",
                  ) ?? []),
                ];
                const at = rows.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (at < 0) return;
                event.preventDefault();
                const next = at + (event.key === "ArrowDown" ? 1 : -1);
                if (next < 0) search.current?.focus();
                else rows[Math.min(next, rows.length - 1)]?.focus();
              }}
            >
              {workspaces.length === 0 && (
                <p className="text-muted-foreground px-2 py-3 text-[13px]">
                  No projects on this account yet.
                </p>
              )}
              {workspaces.length > 0 && shownWorkspaces.length === 0 && (
                <p className="text-muted-foreground truncate px-2 py-3 text-[13px]">
                  No project matches “{query.trim()}”.
                </p>
              )}
              {shownWorkspaces.map((workspace) => (
                <button
                  key={workspace.slug}
                  type="button"
                  role="option"
                  aria-selected={workspace.slug === active?.slug}
                  onClick={() => go(workspace.slug)}
                  className={`${RAIL_ROW} relative aria-selected:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] flex h-7 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`}
                >
                  <ProjectTile
                    workspace={workspace}
                    className="size-5 rounded-[5px] text-[10px]"
                  />
                  <span className="truncate">{workspace.name}</span>
                  {isLocalWorkspace(workspace) && <LocalBadge />}
                  <RunningAgents agents={runningIn(workspace)} />
                </button>
              ))}
            </div>
          </RailHover>
          <RailHover className="border-foreground/10 mt-1 flex gap-0.5 border-t pt-1">
            {/* ⚠️ A row that opens a DIALOG, and the menu closes behind it. A
              project is named and pointed at its folders in one go now, and
              that does not fit — nor belong — inside a menu people open to
              switch. */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] flex h-7 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                className="text-muted-foreground size-4 shrink-0 mx-0.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              New project
            </button>
            {/* Every project's settings in one place: Settings → Projects. */}
            <button
              type="button"
              aria-label="Project settings"
              title="Project settings"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/workspaces" });
              }}
              className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] text-muted-foreground hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-150 focus:outline-none`}
            >
              <HugeiconsIcon
                icon={Settings01Icon}
                className="size-4"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Sort projects"
                    title="Sort projects"
                    className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] text-muted-foreground hover:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-150 focus:outline-none`}
                  >
                    <HugeiconsIcon
                      icon={Sorting05Icon}
                      className="size-4"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </button>
                }
              />
              <DropdownMenuContent align="end">
                {/* ⚠️ `closeOnClick`: a radio item keeps Base UI's menu open by
                    default, and the next press of the trigger then only
                    closed it instead of letting a second order be picked. */}
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as ProjectSort)}
                >
                  <DropdownMenuRadioItem value="default" closeOnClick>
                    Default
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name" closeOnClick>
                    Name
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="activate" closeOnClick>
                    Activate
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </RailHover>
        </PopoverContent>
      </Popover>
      {/* Outside the popover on purpose: rendered inside it, closing the menu
          would unmount the dialog the menu just opened. */}
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={go}
      />
    </>
  );
}
