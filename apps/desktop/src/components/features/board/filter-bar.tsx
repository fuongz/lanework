import {
  ArrowRight01Icon,
  Cancel01Icon,
  FilterIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type { BoardCard } from "#/../shared/workspaces";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import { RAIL_ROW, RailHover } from "#/components/shared/navigation/rail-hover";
import { Button } from "#/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import type { IssueSearch } from "#/lib/issue-search";
import { useBoard } from "#/stores/board";
import {
  activeFilters,
  type FilterField,
  type FilterOption,
  filterFields,
} from "./filter-bar.fields";

/**
 * How many options one list will draw.
 *
 * ⚠️ A cap, not a page. A tag vocabulary is unbounded — a board with two
 * thousand tags would otherwise mount two thousand rows on every keystroke —
 * and the search box is how you reach the ones past it. The list says so when
 * it is holding back.
 */
const MAX_OPTIONS = 50;

/** The glyph an option carries, which is the board's own tone or nothing. */
function OptionGlyph({
  field,
  option,
}: {
  field: FilterField;
  option: FilterOption;
}) {
  if (field.key === "status")
    return (
      <StatusIcon
        column={{
          key: option.value,
          name: option.label,
          role: null,
          icon: option.lane ?? "circle-dashed",
          tone: option.tone ?? "neutral",
          position: 0,
        }}
      />
    );
  if (field.key === "priority")
    return (
      <PriorityIcon
        priority={
          (option.value === "none"
            ? null
            : option.value) as BoardCard["priority"]
        }
      />
    );
  if (field.key === "category")
    return (
      <CategoryDot
        category={{
          key: option.value,
          name: option.label,
          prefix: "",
          tone: option.tone ?? "neutral",
        }}
      />
    );
  return (
    <HugeiconsIcon
      icon={Tag01Icon}
      className="text-muted-foreground size-3.5 shrink-0"
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

/**
 * One field's values, searchable.
 *
 * ⚠️ `shouldFilter={false}`: cmdk's own matcher cannot be capped, and a list
 * that filters 2000 rows and then draws 50 has already paid for all 2000. The
 * query is applied here, then the slice.
 */
function ValuePicker({
  field,
  selected,
  onPick,
  onClear,
}: {
  field: FilterField;
  selected: string | undefined;
  onPick: (value: string) => void;
  onClear?: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? field.options.filter((option) =>
        option.label.toLowerCase().includes(needle),
      )
    : field.options;
  const shown = matched.slice(0, MAX_OPTIONS);

  return (
    // ⚠️ ONE 4px inset for the whole picker, and it comes from `Command`'s own
    // padding. The input wrapper and the list each add another 4 by default, so
    // both are zeroed here — stacking them made every outer gap 8 while the gaps
    // between controls stayed 4, which is the mismatch this removes. The
    // wrapper keeps a 4px bottom: that is the gap down to the first row.
    <Command
      shouldFilter={false}
      className="[&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=command-input-wrapper]]:pb-1"
    >
      {onClear ? (
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <CommandInput
              className="text-[13px]"
              placeholder={field.label}
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            onClick={onClear}
          >
            Clear
          </Button>
        </div>
      ) : (
        <CommandInput
          className="text-[13px]"
          placeholder={field.label}
          value={query}
          onValueChange={setQuery}
        />
      )}
      <CommandList>
        <RailHover
          key={query}
          className="[&[data-hovering=true]_[data-slot=command-item]]:bg-transparent"
        >
          <CommandEmpty>No matches.</CommandEmpty>
          {shown.map((option) => (
            <CommandItem
              key={option.value}
              value={option.value}
              // ⚠️ `data-checked` rather than a tick of our own. `CommandItem`
              // already renders the registry's indicator — the same `Tick02Icon`
              // a `DropdownMenuCheckboxItem` uses — and it only needs to be told
              // the row is on. A hand-rolled badge here was a second way to draw
              // the same state, and it did not match the menus beside it.
              data-checked={selected === option.value ? "true" : undefined}
              onSelect={() => onPick(option.value)}
              className={`${RAIL_ROW} min-h-8 gap-2.5 text-[13px]`}
            >
              <OptionGlyph field={field} option={option} />
              <span className="truncate">{option.label}</span>
            </CommandItem>
          ))}
          {matched.length > shown.length && (
            // ⚠️ Said out loud. A list that silently stops at 50 makes the search
            // box look broken to anybody whose value is the 51st.
            <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
              {matched.length - shown.length} more — keep typing.
            </p>
          )}
        </RailHover>
      </CommandList>
    </Command>
  );
}

/** The one button, and the two panes behind it. */
function FilterMenu({
  fields,
  search,
  onPick,
}: {
  fields: FilterField[];
  search: IssueSearch;
  onPick: (key: FilterField["key"], value: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  /** The one field whose values are showing, beside the list — not instead. */
  const [openField, setOpenField] = useState<FilterField["key"] | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  // Every timer this component starts is cleared when it goes away. Written
  // against the REF rather than `cancelHover`, whose identity changes on every
  // render and would make this a cleanup that runs on each one.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  /**
   * Open a field's values on hover.
   *
   * ⚠️ Instant when a submenu is already showing, delayed when none is. Moving
   * between rows should feel like one menu switching panes; the first open is
   * the one a pointer merely passing over the list would trigger by accident,
   * and a menu that flashes open on the way somewhere else is worse than one
   * that waits a moment.
   */
  const hover = (key: FilterField["key"]) => {
    cancelHover();
    if (openField !== null) {
      setOpenField(key);
      return;
    }
    hoverTimer.current = setTimeout(() => setOpenField(key), 90);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setOpenField(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5">
            <HugeiconsIcon
              icon={FilterIcon}
              className="size-3.5"
              strokeWidth={1.8}
            />
            Filter
          </Button>
        }
      />
      <PopoverContent align="end" className="w-52 p-1.5">
        {/* ⚠️ The field list STAYS while its values are open. Swapping the
            panel for the values hid the other fields behind a back button and
            cost a click to compare two of them — the whole point of a submenu
            is that you can still see what you are choosing between. */}
        <RailHover>
          <div role="menu" aria-label="Filter by" className="flex flex-col">
            {fields.map((entry) => (
              <Popover
                key={entry.key}
                open={openField === entry.key}
                // ⚠️ A press on the row never CLOSES the submenu. Hover already
                // opened it, and a trigger that toggles would make the click a
                // person makes to confirm what they are hovering shut the very
                // panel they were reading. Every other close — outside press,
                // Escape, picking a value — still lands here.
                onOpenChange={(next, details) => {
                  if (!next && details?.reason === "trigger-press") return;
                  setOpenField(next ? entry.key : null);
                }}
              >
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      onMouseEnter={() => hover(entry.key)}
                      onMouseLeave={cancelHover}
                      // ⚠️ NOT `onFocus`. Base UI focuses the first row when the
                      // menu opens, so opening on focus meant one click on
                      // "Filter" produced two panels — the field list and
                      // whichever submenu happened to be first. Hover opens it;
                      // pressing the row (Enter, Space, click) opens it too.
                      className={`${RAIL_ROW} relative aria-expanded:bg-foreground/[0.05] flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px]`}
                    >
                      <HugeiconsIcon
                        icon={entry.icon}
                        className="text-muted-foreground size-4 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {entry.label}
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        className="text-muted-foreground ml-auto size-3.5 shrink-0"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </button>
                  }
                />
                <PopoverContent
                  side="right"
                  align="start"
                  sideOffset={6}
                  className="w-56 p-0"
                >
                  <ValuePicker
                    field={entry}
                    selected={search[entry.key]}
                    onPick={(value) => {
                      setOpenField(null);
                      setOpen(false);
                      onPick(entry.key, value);
                    }}
                  />
                </PopoverContent>
              </Popover>
            ))}
          </div>
        </RailHover>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One filter in play: what, the relation, and the value — three cells.
 *
 * ⚠️ The VALUE cell is a button. Changing "Status is Done" to "Status is
 * In Progress" is the commonest edit there is, and routing it back through the
 * Filter menu means removing a chip and building the same filter again.
 */
function FilterChip({
  field,
  option,
  onPick,
  onRemove,
}: {
  field: FilterField;
  option: FilterOption;
  onPick: (value: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border flex h-7 items-center rounded-md border text-xs">
      <span className="flex items-center gap-1.5 px-2">
        <HugeiconsIcon
          icon={field.icon}
          className="text-muted-foreground size-3.5"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {field.label}
      </span>
      <span className="border-border text-muted-foreground border-l px-2">
        is
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Change ${field.label} filter`}
              className="border-border hover:bg-foreground/[0.04] flex h-full items-center gap-1.5 border-l px-2"
            >
              <OptionGlyph field={field} option={option} />
              <span className="max-w-32 truncate font-medium">
                {option.label}
              </span>
            </button>
          }
        />
        <PopoverContent align="start" className="w-56 p-0">
          <ValuePicker
            field={field}
            selected={option.value}
            onPick={(value) => {
              onPick(value);
              setOpen(false);
            }}
            onClear={() => {
              onRemove();
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={`Remove ${field.label} filter`}
        onClick={onRemove}
        className="border-border hover:bg-foreground/[0.06] flex h-full items-center border-l px-1.5"
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="text-muted-foreground size-3.5"
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}

export function FilterBar({
  search,
  onSearch,
}: {
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
}) {
  const view = useBoard((state) => state.view);
  const fields = filterFields(view);
  const active = activeFilters(fields, search);
  const set = (key: FilterField["key"], value: string | undefined) =>
    onSearch({ ...search, [key]: value });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {active.map(({ field, option }) => (
        <FilterChip
          key={field.key}
          field={field}
          option={option}
          onPick={(value) => set(field.key, value)}
          onRemove={() => set(field.key, undefined)}
        />
      ))}
      {fields.length > 0 && (
        // ⚠️ Keyed on the applied filters, which REMOUNTS the menu whenever one
        // lands. Closing it from the click that picked a value does not stick:
        // that click also navigates — the filters live in the URL — and the
        // close is lost in the re-render, leaving a menu open over the chip it
        // just created. A remount is the one close that cannot be raced.
        <FilterMenu
          key={JSON.stringify(search)}
          fields={fields}
          search={search}
          onPick={set}
        />
      )}
    </div>
  );
}
