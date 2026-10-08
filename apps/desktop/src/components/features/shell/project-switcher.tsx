import {
  Add01Icon,
  Settings01Icon,
  Sorting05Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { TerminalSession } from "#/../shared/terminal";
import type { Workspace } from "#/../shared/workspaces";
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
import { useOpenProject } from "#/stores/last-route";

/** The terminal key a project's agents are filed under (FE-19, FE-26). */
const keyOf = (workspace: Workspace) => workspace.id ?? workspace.slug;

const NO_AGENTS: TerminalSession[] = [];
type ProjectSort = "default" | "name" | "activate";

/**
 * The agents running in a project on this machine, as overlapping marks.
 *
 * ⚠️ Capped at three with the rest counted, like `AvatarStack`: a project with
 * five agents going says five, not three and silence.
 */
function RunningAgents({ agents }: { agents: TerminalSession[] }) {
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
export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<ProjectSort>("default");
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const openProject = useOpenProject();
  const navigate = useNavigate();
  const agentsByKey = useAgentTerminals((state) => state.sessions);
  const refreshAgents = useAgentTerminals((state) => state.refresh);
  const hasAgents = (workspace: Workspace) =>
    (agentsByKey[keyOf(workspace)] ?? NO_AGENTS).some(
      (agent) =>
        !agent.exit && (agent.kind === "claude" || agent.kind === "codex"),
    );
  const sortedWorkspaces =
    sort === "default"
      ? workspaces
      : [...workspaces].sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            : Number(hasAgents(b)) - Number(hasAgents(a)),
        );

  // ⚠️ Asked for EVERY project each time the menu opens. The rail only lists
  // the open project's agents, so without this the other rows would show
  // whatever was running the last time each one was open — or nothing.
  useEffect(() => {
    if (!open) return;
    for (const workspace of workspaces) void refreshAgents(keyOf(workspace));
  }, [open, workspaces, refreshAgents]);

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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              // ⚠️ Named for what it DOES, with the current project inside the
              // name. A button whose accessible name is only "Lanework" tells a
              // screen-reader user what they are looking at and nothing about
              // what pressing it would do.
              aria-label={`Switch project — currently ${active?.name ?? "none"}`}
              className="hover:bg-foreground/[0.05] flex h-8 w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-150"
            >
              <ProjectTile workspace={active} className="size-6 text-[11px]" />
              <span className="truncate text-[13px] font-medium">
                {active?.name ?? "Choose a project"}
              </span>
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                className="text-muted-foreground ml-auto size-3.5 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          }
        />
        <PopoverContent align="start" className="w-60 gap-0 p-1">
          <RailHover className="max-h-80 overflow-y-auto">
            <div
              role="listbox"
              aria-label="Projects"
              className="flex flex-col gap-0.5"
            >
              {workspaces.length === 0 && (
                <p className="text-muted-foreground px-2 py-3 text-[13px]">
                  No projects on this account yet.
                </p>
              )}
              {sortedWorkspaces.map((workspace) => (
                <button
                  key={workspace.slug}
                  type="button"
                  role="option"
                  aria-selected={workspace.slug === active?.slug}
                  onClick={() => go(workspace.slug)}
                  className={`${RAIL_ROW} relative aria-selected:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`}
                >
                  <ProjectTile
                    workspace={workspace}
                    className="size-5 rounded-[5px] text-[10px]"
                  />
                  <span className="truncate">{workspace.name}</span>
                  <RunningAgents
                    agents={(agentsByKey[keyOf(workspace)] ?? NO_AGENTS).filter(
                      (agent) => !agent.exit,
                    )}
                  />
                </button>
              ))}
            </div>
          </RailHover>
          <RailHover className="border-border mt-1 flex gap-0.5 border-t pt-1">
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
              className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`}
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
              className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] text-muted-foreground hover:text-foreground grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-150 focus:outline-none`}
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
                    className={`${RAIL_ROW} relative focus-visible:bg-foreground/[0.08] text-muted-foreground hover:text-foreground grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-150 focus:outline-none`}
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
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as ProjectSort)}
                >
                  <DropdownMenuRadioItem value="default">
                    Default
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">
                    Name
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="activate">
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
