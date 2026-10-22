import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import { matches, SETTINGS_GROUPS } from "#/lib/settings-catalog";
import { useSettingsSearch } from "#/stores/settings-search";

/** The grouped section list, filtered by whatever is in the search box. */
export function SettingsNav() {
  const query = useSettingsSearch((state) => state.query);

  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      matches(query, item.label, item.keywords, group.label),
    ),
  })).filter((group) => group.items.length > 0);

  if (groups.length === 0)
    return (
      <p className="text-muted-foreground px-2 py-6 text-[13px]">
        No settings match “{query.trim()}”.
      </p>
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
              <Link
                key={item.label}
                to={item.to}
                className={`${RAIL_ROW} group relative flex h-[30px] items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]`}
                activeProps={{
                  className: "bg-foreground/[0.08]",
                  "aria-current": "page",
                }}
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
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </RailHover>
  );
}
