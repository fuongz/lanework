import {
  CloudSavingDone01Icon,
  GridViewIcon,
  Menu01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/shared/navigation/select";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { GROUP_BY, type GroupBy } from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";
import { useBoard } from "#/stores/board";
import { FilterBar } from "./filter-bar";

const when = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "an unknown time"
    : at.toLocaleTimeString();
};

const GROUP_LABEL: Record<GroupBy, string> = {
  status: "Status",
  category: "Category",
  priority: "Priority",
};

/**
 * How fresh the board is, as the refresh button's tooltip.
 *
 * ⚠️ Two states with two different glyphs and two different words, never one
 * string with a separator in it. "Nothing here" and "I could not ask" look
 * identical on screen otherwise, and somebody who trusts an empty board starts
 * typing a card that already exists.
 */
function Freshness({ stale, at }: { stale: boolean; at: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {stale ? (
        <HugeiconsIcon
          icon={CloudSavingDone01Icon}
          className="text-tone-amber size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          className="bg-tone-emerald size-1.5 rounded-full"
        />
      )}
      <span>{stale ? "Saved copy" : "Live"}</span>
      <span className="tabular-nums opacity-70">{when(at)}</span>
    </span>
  );
}

/**
 * List or lanes — the same issues, drawn two ways (FE-13/D4).
 *
 * ⚠️ Switching keeps every filter, and the list's grouping too: the group is
 * simply not read on the lanes, so coming back to the list finds it where it
 * was. Two buttons with `aria-pressed` rather than a tab list, because what
 * they switch is how THIS region is drawn, not which panel is shown.
 *
 * ⚠️ Labelled, not icon-only: two glyphs side by side made you hover to learn
 * which was which. The pill SLIDES between them (`SegmentedControl`) inside a
 * bar that stays mounted across the switch (`IssuesView` owns it), so it only
 * ever glides between its own two positions — never in from wherever a
 * previous page left it. `MotionConfig reducedMotion="user"` at the root turns the glide into a jump
 * for anyone who asked for less motion.
 */
function ViewSwitch({
  search,
  onSearch,
}: {
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
}) {
  return (
    <SegmentedControl
      label="View"
      value={search.view ?? "list"}
      options={[
        { value: "list", label: "List", icon: Menu01Icon },
        { value: "board", label: "Board", icon: GridViewIcon },
      ]}
      onChange={(value) =>
        onSearch({ ...search, view: value === "board" ? "board" : undefined })
      }
    />
  );
}

/**
 * The bar every board view wears: what it is, how it is cut, and how fresh.
 *
 * ⚠️ `grouping` is optional because the lanes view has exactly one sensible
 * grouping — its lanes — and offering "group by priority" on a screen whose
 * columns ARE the status would be a control that contradicts the picture.
 */
export function ViewToolbar({
  title,
  search,
  onSearch,
  grouping = true,
}: {
  title: string;
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
  grouping?: boolean;
}) {
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const reload = useBoard((state) => state.reload);

  return (
    <div className="border-border flex shrink-0 flex-col gap-2 border-b pe-6 ps-[max(1.5rem,var(--titlebar-clear,0px))] pt-2 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {/* ⚠️ Beside the title, not with the controls on the right. "Group"
            only exists on the list, so on the right the switch jumped sideways
            by that select's width every time it was pressed — the one control
            that must not move is the one you just clicked. */}
        <div className="mr-auto">
          <ViewSwitch search={search} onSearch={onSearch} />
        </div>

        {grouping && (
          <Select
            value={search.group ?? "status"}
            onValueChange={(value) =>
              onSearch({ ...search, group: value as GroupBy })
            }
          >
            {/* ⚠️ `size="default"` is what makes this 28px. The `sm` variant
                sets its height through a `data-[size=sm]` variant, which a
                plain `h-7` in `className` cannot override — the trigger stayed
                24px beside a 28px Filter button, and the two read as different
                kinds of control. */}
            <SelectTrigger
              size="default"
              aria-label="Group by"
              className="gap-1.5 text-xs"
            >
              <span className="text-muted-foreground">Group</span>
              {/* ⚠️ A formatter, not a bare `SelectValue`. Left to itself it
                  renders the item's VALUE — the trigger read "status" where the
                  menu it opens says "Status". */}
              <SelectValue>
                {(value: string) => GROUP_LABEL[value as GroupBy] ?? value}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GROUP_BY.map((option) => (
                <SelectItem key={option} value={option}>
                  {GROUP_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <FilterBar search={search} onSearch={onSearch} />

        {/* ⚠️ The freshness lives in the TOOLTIP now, and in the button's name
            for anybody who cannot hover. A SAVED copy still marks the button
            itself — the one state that must not wait for a hover to be seen. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative size-7"
                aria-label={
                  view
                    ? `Refresh board — ${view.stale ? "Saved copy" : "Live"}, ${when(view.fetchedAt)}`
                    : "Refresh board"
                }
                disabled={loading}
                onClick={() => void reload()}
              />
            }
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              className="size-4"
              strokeWidth={1.5}
            />
            {view?.stale && (
              <span
                aria-hidden="true"
                className="bg-tone-amber absolute top-1 right-1 size-1.5 rounded-full"
              />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {view ? (
              <Freshness stale={view.stale} at={view.fetchedAt} />
            ) : (
              "Refresh board"
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
