import {
  Clock01Icon,
  GitCompareIcon,
  ListViewIcon,
  PencilEdit02Icon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { AccountOrb } from "#/components/shared/common/account-orb";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useCommandPalette } from "#/stores/command-palette";

/** One square slot of the mini rail; the open page gets the pill. */
const SLOT =
  "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] aria-[current]:bg-foreground/[0.08] aria-[current]:text-foreground grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50";

const ACTIVE = { "aria-current": "page" as const };

function Icon({ icon }: { icon: IconSvgElement }) {
  return (
    <HugeiconsIcon
      icon={icon}
      className="size-[18px]"
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

/**
 * A slot with its name beside it on hover. The accessible name is the same
 * word the row has when the rail is open, so "Issues" is "Issues" either way;
 * the shortcut rides in the tooltip only.
 */
function Slot({
  label,
  shortcut,
  render,
  icon,
}: {
  label: string;
  shortcut?: string;
  render: ReactElement;
  icon: IconSvgElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={render}>
        <Icon icon={icon} />
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {shortcut && <span className="opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The rail folded to its icons (FE-58): what the open rail offers, one square
 * each, with the sidebar button on top to open it again.
 *
 * Agents shows one icon per agent — running, pinned, then the most recent —
 * named in its tooltip; sub-agents stay the open rail's.
 */
export function MiniRail({
  slug,
  accountSeed,
  projectSwitcher,
  agents,
  onExpand,
  appear = false,
}: {
  slug: string | undefined;
  accountSeed: string;
  /** The open rail's switcher in its compact form, handed in by the rail. */
  projectSwitcher: ReactNode;
  /** The project's agents as icons — running, pinned, recent — or null. */
  agents: ReactNode;
  onExpand: () => void;
  /** Fade in: true when it replaces the open rail, not at launch. */
  appear?: boolean;
}) {
  const navigate = useNavigate();
  const open = useCommandPalette((state) => state.open);
  return (
    <TooltipProvider delay={300}>
      <aside
        data-mini=""
        aria-label="Sidebar"
        // ⚠️ A fixed 56px column at the rail's left edge, not one that fills
        // the panel: while the rail glides shut the icons stay put instead of
        // drifting from the middle of a narrowing column to its edge.
        className={`app-sidebar flex min-h-0 w-14 flex-1 flex-col items-center ${appear ? "motion-safe:animate-in motion-safe:fade-in-0 duration-200" : ""}`}
      >
        {/* No spacer for the window controls: folded, the window's title bar
            above the rail holds them (FE-58). */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pt-2 pb-2.5">
          <Slot
            label="Show sidebar"
            shortcut="⌘B"
            icon={SidebarLeftIcon}
            render={
              <button
                type="button"
                onClick={onExpand}
                aria-label="Show sidebar"
                className={SLOT}
              />
            }
          />
          {projectSwitcher}
          <Slot
            label="New issue"
            shortcut="⌘N"
            icon={PencilEdit02Icon}
            render={
              <button
                type="button"
                disabled={!slug}
                aria-label="New issue"
                onClick={() =>
                  slug &&
                  void navigate({ to: "/w/$slug/issues/new", params: { slug } })
                }
                className={SLOT}
              />
            }
          />
          <Slot
            label="Search"
            shortcut="⌘K"
            icon={Search01Icon}
            render={
              <button
                type="button"
                onClick={open}
                aria-label="Search"
                className={SLOT}
              />
            }
          />
          {slug && (
            <nav
              aria-label="Project"
              className="flex flex-col items-center gap-1 pt-2"
            >
              <Slot
                label="Issues"
                icon={ListViewIcon}
                render={
                  <Link
                    to="/w/$slug/issues"
                    params={{ slug }}
                    search={{}}
                    aria-label="Issues"
                    className={SLOT}
                    activeOptions={{ includeSearch: false }}
                    activeProps={ACTIVE}
                  />
                }
              />
            </nav>
          )}
          {slug && (
            <nav
              aria-label="Repository"
              className="flex flex-col items-center gap-1"
            >
              <Slot
                label="Changes"
                icon={GitCompareIcon}
                render={
                  <Link
                    to="/w/$slug/changes"
                    params={{ slug }}
                    aria-label="Changes"
                    className={SLOT}
                    activeProps={ACTIVE}
                  />
                }
              />
              <Slot
                label="History"
                icon={Clock01Icon}
                render={
                  <Link
                    to="/w/$slug/history"
                    params={{ slug }}
                    aria-label="History"
                    className={SLOT}
                    activeProps={ACTIVE}
                  />
                }
              />
            </nav>
          )}
          {agents && <div className="pt-2">{agents}</div>}
          <div className="mt-auto flex flex-col items-center gap-1 pt-2">
            <Slot
              label="Settings"
              icon={Settings01Icon}
              render={
                <Link
                  to="/settings"
                  aria-label="Settings"
                  className={SLOT}
                  activeProps={ACTIVE}
                />
              }
            />
            {accountSeed && (
              <AccountOrb seed={accountSeed} className="size-5 shrink-0" />
            )}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}
