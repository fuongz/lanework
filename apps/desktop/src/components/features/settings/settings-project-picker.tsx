import {
  Add01Icon,
  Search01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { CreateProjectDialog } from "#/components/shared/common/create-project-dialog";
import { ProjectTile } from "#/components/shared/common/project-tile";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { useBoard } from "#/stores/board";
import { isLocalWorkspace } from "#/stores/session";
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

/**
 * The project Settings › Projects is about, in the title bar of each of its
 * pages.
 *
 * The project switcher's button and menu (a search, the list, and New
 * project), but picking only chooses what these pages show.
 */
export function SettingsProjectPicker() {
  const workspaces = useBoard((state) => state.workspaces);
  const selected = useSettingsProject();
  const pick = useSettingsProjectPick((state) => state.pick);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const needle = fold(query.trim());
  const shown = needle
    ? workspaces.filter(
        (workspace) =>
          fold(workspace.name).includes(needle) ||
          fold(workspace.slug).includes(needle),
      )
    : workspaces;

  const choose = (slug: string) => {
    setOpen(false);
    pick(slug);
  };

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
              aria-label={`Pick a project — currently ${selected?.name ?? "none"}`}
              // - `-ml-3.5`: the slot keeps 17px clear of the card's edge for a
              //   page's title; the picker's tile sits close to it instead.
              // Its height is centred with the page's title by the shell's
              // `.settings-titlebar` (app.css), not here.
              className="hover:bg-foreground/[0.05] -ml-3.5 mr-3 flex h-7 min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-150"
            >
              <ProjectTile
                workspace={selected}
                className="size-4 rounded-[4px] text-[9px]"
              />
              <span className="truncate text-[13px] font-medium">
                {selected?.name ?? "Choose a project"}
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
                  if (event.key === "Enter" && shown[0]) {
                    event.preventDefault();
                    choose(shown[0].slug);
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
              {workspaces.length === 0 && (
                <p className="text-muted-foreground px-2 py-3 text-[13px]">
                  No projects yet.
                </p>
              )}
              {workspaces.length > 0 && shown.length === 0 && (
                <p className="text-muted-foreground truncate px-2 py-3 text-[13px]">
                  No project matches “{query.trim()}”.
                </p>
              )}
              {shown.map((workspace) => (
                <button
                  key={workspace.slug}
                  type="button"
                  role="option"
                  aria-selected={workspace.slug === selected?.slug}
                  onClick={() => choose(workspace.slug)}
                  className={`${RAIL_ROW} relative aria-selected:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] flex h-7 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus:outline-none`}
                >
                  <ProjectTile
                    workspace={workspace}
                    className="size-5 rounded-[5px] text-[10px]"
                  />
                  <span className="truncate">{workspace.name}</span>
                  {isLocalWorkspace(workspace) && <LocalBadge />}
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
        onCreated={pick}
      />
    </>
  );
}
