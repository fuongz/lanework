import {
  Add01Icon,
  DashboardSquare02Icon,
  Search01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import type { Project } from "#/../shared/projects";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import { CreateProjectDialog } from "#/components/shared/projects/create-project-dialog";
import { ProjectTile } from "#/components/shared/projects/project-tile";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { isLocalProject } from "#/stores/session";
import {
  useSettingsProject,
  useSettingsProjectPick,
} from "#/stores/settings-project";

/** Lower case, accents off: `Đơn` finds `don`, `Acme` finds `acme`. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

const ALL = "All projects";

/** The option rows' look, shared by "All projects" and each project. */
const OPTION = `${RAIL_ROW} relative aria-selected:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] flex h-7 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`;

/**
 * What a scoped Settings page applies to (FE-145): "Applying settings for"
 * and a menu of "All projects" (where the page has one) and every project.
 *
 * Skills, MCP and Archived read the choice from `stores/settings-project`, so
 * it carries from one page to the next. A project's own page passes
 * `current` and `onChoose` instead: there the URL names the project, and
 * picking another one goes to its page.
 *
 * The project switcher's menu (a search, the list, New project), but
 * choosing only changes what Settings shows, never the app's open project.
 */
export function SettingsScope({
  allowAll = false,
  current,
  onChoose,
  crumb = false,
  className,
}: {
  /**
   * Drawn as the breadcrumb's last crumb (a project's page, FE-161): the
   * project's tile, name and chevron, no "Applying settings for" and no box.
   */
  crumb?: boolean;
  /** Offer "All projects": Skills and MCP, not Archived. */
  allowAll?: boolean;
  /** The project shown, when the page knows it better than the store. */
  current?: Project | null;
  /** After a project is chosen (and stored): a project page navigates. */
  onChoose?: (slug: string) => void;
  className?: string;
}) {
  const projects = useBoard((state) => state.projects);
  const stored = useSettingsProject();
  const all = useSettingsProjectPick((state) => state.all) && allowAll;
  const pick = useSettingsProjectPick((state) => state.pick);
  const setAll = useSettingsProjectPick((state) => state.setAll);
  const selected = current === undefined ? stored : current;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const needle = fold(query.trim());
  const shown = needle
    ? projects.filter(
        (project) =>
          fold(project.name).includes(needle) ||
          fold(project.slug).includes(needle),
      )
    : projects;
  // "All projects" is a row like the others, so the search can find it too.
  const showAll = allowAll && (!needle || fold(ALL).includes(needle));

  const choose = (slug: string) => {
    setOpen(false);
    pick(slug);
    onChoose?.(slug);
  };
  const chooseAll = () => {
    setOpen(false);
    setAll(true);
  };

  const label = all ? ALL : (selected?.name ?? "Choose a project");

  return (
    <div
      className={cn("flex min-w-0 items-center gap-2 text-[13px]", className)}
    >
      {!crumb && (
        <span className="text-muted-foreground shrink-0">
          Applying settings for
        </span>
      )}
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
              aria-label={
                crumb
                  ? `${label}, switch project`
                  : `Applying settings for ${label}. Change`
              }
              className={
                crumb
                  ? "hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] -mx-1.5 flex min-w-0 max-w-72 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[14px] leading-5 transition-colors"
                  : "border-input hover:bg-foreground/[0.04] flex h-8 min-w-0 max-w-64 items-center gap-2 rounded-lg border px-2.5 text-left transition-colors duration-150"
              }
            >
              {all ? (
                <HugeiconsIcon
                  icon={DashboardSquare02Icon}
                  className="text-muted-foreground size-4 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              ) : (
                <ProjectTile
                  project={selected}
                  className="size-4 rounded-[4px] text-[9px]"
                />
              )}
              <span
                className={cn(
                  "truncate",
                  crumb ? "font-semibold" : "font-medium",
                )}
                aria-current={crumb ? "page" : undefined}
              >
                {label}
              </span>
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                className="text-muted-foreground size-3.5 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          }
        />
        <PopoverContent
          variant="menu"
          align="start"
          initialFocus={search}
          // A set width: as wide as its rows, it would narrow with every
          // letter typed.
          className="w-72 p-1"
        >
          {projects.length > 0 && (
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
                  if (event.key === "Enter" && (showAll || shown[0])) {
                    event.preventDefault();
                    if (showAll) chooseAll();
                    else if (shown[0]) choose(shown[0].slug);
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
          <RailHover className="max-h-96 overflow-y-auto">
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
              {showAll && (
                <button
                  type="button"
                  role="option"
                  aria-selected={all}
                  onClick={chooseAll}
                  className={OPTION}
                >
                  <HugeiconsIcon
                    icon={DashboardSquare02Icon}
                    className="text-muted-foreground size-5 shrink-0"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <span className="truncate">{ALL}</span>
                </button>
              )}
              {projects.length === 0 && (
                <Empty className="px-2 py-4">
                  <EmptyHeader>
                    <EmptyTitle>No projects yet</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
              {projects.length > 0 && shown.length === 0 && !showAll && (
                <Empty className="px-2 py-4">
                  <EmptyHeader>
                    <EmptyTitle>No matches</EmptyTitle>
                    <EmptyDescription className="max-w-full truncate">
                      No project matches “{query.trim()}”.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {shown.map((project) => (
                <button
                  key={project.slug}
                  type="button"
                  role="option"
                  aria-selected={!all && project.slug === selected?.slug}
                  onClick={() => choose(project.slug)}
                  className={OPTION}
                >
                  <ProjectTile
                    project={project}
                    className="size-5 rounded-[5px] text-[10px]"
                  />
                  <span className="truncate">{project.name}</span>
                  {isLocalProject(project) && <LocalBadge />}
                </button>
              ))}
            </div>
          </RailHover>
          <RailHover className="border-foreground/10 mt-1 flex border-t pt-1">
            {/* A dialog, so the menu closes behind it. */}
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
                className="text-muted-foreground mx-0.5 size-4 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              New project
            </button>
          </RailHover>
        </PopoverContent>
      </Popover>
      {/* Outside the popover: rendered inside it, closing the menu would
          unmount the dialog the menu just opened. */}
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={choose}
      />
    </div>
  );
}
