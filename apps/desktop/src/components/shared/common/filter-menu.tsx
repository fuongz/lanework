import {
  ArrowRight01Icon,
  FilterIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { cn } from "#/lib/utils";

/** One value a field can be filtered to. */
export interface MenuOption {
  value: string;
  label: string;
}

/** One thing a list can be filtered on, and the values it offers. */
export interface MenuField {
  key: string;
  label: string;
  icon: IconSvgElement;
  options: MenuOption[];
  /**
   * Several values at once, each with a checkbox. The field's selection is
   * then a comma-separated list, and picking a value toggles it without
   * closing the menu.
   */
  multiple?: boolean;
}

/** A multiple field's selection as a set. */
const pickedOf = (selected: string | undefined) =>
  new Set((selected ?? "").split(",").filter(Boolean));

/** A toggle applied to a multiple field's selection, in the field's order. */
export function toggled(
  field: MenuField,
  selected: string | undefined,
  value: string,
): string {
  const picked = pickedOf(selected);
  if (picked.has(value)) picked.delete(value);
  else picked.add(value);
  return field.options
    .filter((option) => picked.has(option.value))
    .map((option) => option.value)
    .join(",");
}

/**
 * How many options one list will draw.
 *
 * ⚠️ A cap, not a page. A tag vocabulary is unbounded — a board with two
 * thousand tags would otherwise mount two thousand rows on every keystroke —
 * and the search box is how you reach the ones past it. The list says so when
 * it is holding back.
 */
const MAX_OPTIONS = 50;

/**
 * One field's values, searchable.
 *
 * ⚠️ `shouldFilter={false}`: cmdk's own matcher cannot be capped, and a list
 * that filters 2000 rows and then draws 50 has already paid for all 2000. The
 * query is applied here, then the slice.
 */
export function ValuePicker<F extends MenuField>({
  field,
  selected,
  glyph,
  onPick,
  onClear,
}: {
  field: F;
  selected: string | undefined;
  /** The icon an option carries, drawn before its label. */
  glyph: (field: F, option: F["options"][number]) => ReactNode;
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
  const picked = field.multiple ? pickedOf(selected) : null;

  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder={field.label}
        value={query}
        onValueChange={setQuery}
        trailing={
          onClear && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-6 shrink-0 px-2 text-xs"
              onClick={onClear}
            >
              Clear
            </Button>
          )
        }
      />
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
              data-checked={
                !picked && selected === option.value ? "true" : undefined
              }
              aria-checked={picked ? picked.has(option.value) : undefined}
              onSelect={() => onPick(option.value)}
              className={`${RAIL_ROW} gap-2.5`}
            >
              {picked && (
                // A drawn box, not a `Checkbox`: the row is the control, and
                // a button inside an option would be a second one to tab to.
                <span
                  aria-hidden="true"
                  data-on={picked.has(option.value) || undefined}
                  className="border-input data-on:border-primary data-on:bg-primary data-on:text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-[4px] border"
                >
                  {picked.has(option.value) && (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2.2}
                      className="size-3"
                    />
                  )}
                </span>
              )}
              {glyph(field, option)}
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

/**
 * The Filter button, and the two panes behind it: the fields, and the open
 * field's values beside them.
 *
 * NOTE: Shared by the issue list and the pull request list (FE-75), so both
 * filter the same way. Each passes its own fields, what is selected and the
 * icon each value carries.
 */
export function FilterMenu<F extends MenuField>({
  fields,
  selected,
  glyph,
  active,
  onPick,
}: {
  fields: F[];
  /** The value a field is filtered to, or undefined. */
  selected: (key: F["key"]) => string | undefined;
  glyph: (field: F, option: F["options"][number]) => ReactNode;
  /** How many filters are on. */
  active: number;
  onPick: (key: F["key"], value: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  /** The one field whose values are showing, beside the list — not instead. */
  const [openField, setOpenField] = useState<F["key"] | null>(null);
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
  const hover = (key: F["key"]) => {
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
          // An icon, to fit the list's narrow header. It is tinted while a
          // filter is on: a filter is the reason a list looks short, and this
          // button is the first place anybody looks for why.
          <Button
            variant="ghost"
            size="icon"
            aria-label="Filter"
            title={active ? `Filter — ${active} on` : "Filter"}
            className={cn(
              "size-7",
              active > 0 && "bg-accent-brand/15 text-accent-brand",
            )}
          >
            <HugeiconsIcon
              icon={FilterIcon}
              className={cn("size-3.5", !active && "text-muted-foreground")}
              strokeWidth={1.8}
            />
          </Button>
        }
      />
      <PopoverContent variant="menu" align="end" className="p-1">
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
                      className={`${RAIL_ROW} relative aria-expanded:bg-foreground/[0.05] flex h-7 items-center gap-2.5 rounded-md px-2 text-left text-[13px]`}
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
                  variant="menu"
                  side="right"
                  align="start"
                  sideOffset={6}
                >
                  <ValuePicker
                    field={entry}
                    selected={selected(entry.key)}
                    glyph={glyph}
                    onPick={(value) => {
                      // A multiple field stays open: ticking three boxes is
                      // three presses, not three trips through the menu.
                      if (entry.multiple) {
                        onPick(
                          entry.key,
                          toggled(entry, selected(entry.key), value),
                        );
                        return;
                      }
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
