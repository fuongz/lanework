import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  matches,
  SETTINGS_GROUPS,
  type SettingsItem,
} from "#/lib/settings-catalog";
import { useBoard } from "#/stores/board";
import { useSettingsProjectPick } from "#/stores/settings-project";
import { useSettingsSearch } from "#/stores/settings-search";

/** The grouped section list, filtered by whatever is in the search box. */
export function SettingsNav() {
  const query = useSettingsSearch((state) => state.query);
  // Projects opens the project already in hand (picked here, else the one
  // open in the app) rather than the list; the breadcrumb's "Projects" goes
  // back to the list.
  const picked = useSettingsProjectPick((state) => state.picked);
  const active = useBoard((state) => state.active?.slug ?? null);
  const current = picked ?? active;

  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      matches(query, item.label, item.keywords, group.label),
    ),
  })).filter((group) => group.items.length > 0);

  if (groups.length === 0)
    return (
      <Empty className="flex-none px-2 py-6">
        <EmptyHeader>
          <EmptyTitle>No matches</EmptyTitle>
          <EmptyDescription>
            No settings match “{query.trim()}”.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <RailHover>
      <nav aria-label="Settings sections" className="flex flex-col pt-1 pb-4">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="text-muted-foreground flex min-w-0 items-center gap-2 px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase">
              <span className="shrink-0">{group.label}</span>
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.label}
                item={item}
                project={item.to === "/settings/projects" ? current : null}
              >
                <HugeiconsIcon
                  icon={item.icon}
                  // The open section needs a cue beyond a faint background.
                  // Colour costs nothing. A heavier label would want a 2px
                  // stroke here, and the icon set takes stroke as a prop, not
                  // a class.
                  className="text-muted-foreground group-[[aria-current]]:text-foreground size-4 transition-colors duration-150 ease-out"
                  strokeWidth={1.5}
                />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </RailHover>
  );
}

const ROW = `${RAIL_ROW} group relative flex h-[30px] items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]`;
const ACTIVE = { className: "bg-rail-active", "aria-current": "page" as const };

/** A nav row; Projects goes to `project`'s own page when there is one. */
function NavLink({
  item,
  project,
  children,
}: {
  item: SettingsItem;
  project: string | null;
  children: ReactNode;
}) {
  if (project)
    return (
      <Link
        to="/settings/projects/$slug"
        params={{ slug: project }}
        className={ROW}
        activeProps={ACTIVE}
      >
        {children}
      </Link>
    );
  return (
    <Link to={item.to} className={ROW} activeProps={ACTIVE}>
      {children}
    </Link>
  );
}
