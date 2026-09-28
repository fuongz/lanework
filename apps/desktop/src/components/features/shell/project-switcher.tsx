import {
  Add01Icon,
  Settings01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { TerminalSession } from "#/../shared/terminal";
import type { Workspace } from "#/../shared/workspaces";
import { CreateProjectDialog } from "#/components/shared/common/create-project-dialog";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import { useOpenProject } from "#/stores/last-route";

/**
 * A project's colour, derived from its slug.
 *
 * ⚠️ Derived, not stored and not by list position. A colour that came from the
 * index would change the moment somebody creates a project earlier in the
 * alphabet — and the whole point of giving each one a colour is that it is the
 * same tile every time you open the menu.
 */
const TILES = [
  "bg-tone-violet",
  "bg-tone-sky",
  "bg-tone-emerald",
  "bg-tone-amber",
  "bg-tone-teal",
  "bg-tone-rose",
  "bg-tone-blue",
] as const;

function tile(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILES[hash % TILES.length];
}

function Tile({
  workspace,
  className,
}: {
  workspace: Workspace | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-md font-semibold text-white",
        workspace ? tile(workspace.slug) : "bg-muted-foreground",
        className,
      )}
    >
      {(workspace?.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The terminal key a project's agents are filed under (FE-19, FE-26). */
const keyOf = (workspace: Workspace) => workspace.id ?? workspace.slug;

const NO_AGENTS: TerminalSession[] = [];

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
    <span className="ml-auto flex shrink-0 items-center pr-1 pl-2" title={names}>
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
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const openProject = useOpenProject();
  const navigate = useNavigate();
  const agentsByKey = useAgentTerminals((state) => state.sessions);
  const refreshAgents = useAgentTerminals((state) => state.refresh);

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
      const workspace = workspaces[at];
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
              <Tile workspace={active} className="size-6 text-[11px]" />
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
          <div
            role="listbox"
            aria-label="Projects"
            className="flex max-h-80 flex-col gap-0.5 overflow-y-auto"
          >
            {workspaces.length === 0 && (
              <p className="text-muted-foreground px-2 py-3 text-[13px]">
                No projects on this account yet.
              </p>
            )}
            {workspaces.map((workspace) => (
              <button
                key={workspace.slug}
                type="button"
                role="option"
                aria-selected={workspace.slug === active?.slug}
                onClick={() => go(workspace.slug)}
                className="hover:bg-foreground/[0.05] aria-selected:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none"
              >
                <Tile
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

          <div className="border-border mt-1 flex gap-0.5 border-t pt-1">
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
              className="hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.08] flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none"
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
              className="hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.08] text-muted-foreground hover:text-foreground grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-150 focus:outline-none"
            >
              <HugeiconsIcon
                icon={Settings01Icon}
                className="size-4"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
          </div>
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
