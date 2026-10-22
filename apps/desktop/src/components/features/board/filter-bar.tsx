import { Cancel01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { BoardCard } from "#/../shared/workspaces";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import {
  FilterMenu,
  toggled,
  ValuePicker,
} from "#/components/shared/common/filter-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { defaultStatusKeys, statusKeys } from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import {
  activeFilters,
  type FilterField,
  type FilterOption,
  filterFields,
} from "./filter-bar.fields";

/**
 * A status selection as the URL keeps it: `undefined` for the default set (so
 * the default is no filter), `"none"` for every box unticked.
 */
function statusParam(
  columns: readonly { key: string; role: string | null }[],
  value: string,
): string | undefined {
  const keys = value.split(",").filter(Boolean);
  if (!keys.length) return "none";
  const usual = defaultStatusKeys(columns);
  const same =
    keys.length === usual.length && keys.every((key) => usual.includes(key));
  return same ? undefined : keys.join(",");
}

/** {@link OptionGlyph} as the shared menu asks for it. */
const glyph = (field: FilterField, option: FilterOption) => (
  <OptionGlyph field={field} option={option} />
);

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
 * One filter in play, in three cells: what, the relation, and the value.
 *
 * The value cell is a button. Changing "Status is Done" to "Status is In
 * Progress" is the commonest edit there is, and routing it back through the
 * Filter menu means removing a chip and building the same filter again.
 */
function FilterChip({
  field,
  option,
  selected,
  onPick,
  onRemove,
}: {
  field: FilterField;
  option: FilterOption;
  /** What the picker ticks, when it is not `option.value` (status). */
  selected?: string;
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
              {(!field.multiple || option.lane) && (
                <OptionGlyph field={field} option={option} />
              )}
              <span className="max-w-32 truncate font-medium">
                {option.label}
              </span>
            </button>
          }
        />
        <PopoverContent variant="menu" align="start">
          <ValuePicker
            field={field}
            selected={selected ?? option.value}
            glyph={glyph}
            onPick={(value) => {
              // A multiple field toggles in place; a single one picks and
              // closes.
              if (field.multiple) {
                onPick(toggled(field, selected ?? option.value, value));
                return;
              }
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

/** The Filter button, for the list's header. */
export function FilterButton({
  search,
  onSearch,
}: {
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
}) {
  const view = useBoard((state) => state.view);
  const fields = filterFields(view);
  if (!fields.length) return null;
  return (
    // NOTE: Keyed on the applied filters, which remounts the menu whenever one
    // lands. Closing it from the click that picked a value does not stick:
    // that click also navigates (the filters live in the URL), and the close
    // is lost in the re-render, leaving a menu open over the chip it just
    // created. A remount is the one close that cannot be raced.
    <FilterMenu
      // The status set is left out of the key: ticking a box navigates too,
      // and a menu that closed on every tick could not tick three.
      key={JSON.stringify({ ...search, status: undefined })}
      fields={fields}
      selected={(key) =>
        key === "status" && view
          ? statusKeys(view.columns, search.status).join(",")
          : search[key]
      }
      glyph={glyph}
      active={activeFilters(fields, search).length}
      onPick={(key, value) =>
        onSearch({
          ...search,
          [key]:
            key === "status" && view && value !== undefined
              ? statusParam(view.columns, value)
              : value,
        })
      }
    />
  );
}

/**
 * The filters in play, one chip each, or nothing when none are.
 *
 * They wrap rather than scroll sideways: the list's column is narrow, and a
 * chip pushed out of sight is a filter doing something nobody can see.
 */
export function FilterChips({
  search,
  onSearch,
  className,
}: {
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
  className?: string;
}) {
  const view = useBoard((state) => state.view);
  const active = activeFilters(filterFields(view), search);
  if (!active.length) return null;
  const set = (key: FilterField["key"], value: string | undefined) =>
    onSearch({
      ...search,
      [key]:
        key === "status" && view && value !== undefined
          ? statusParam(view.columns, value)
          : value,
    });
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {active.map(({ field, option }) => (
        <FilterChip
          key={field.key}
          field={field}
          option={option}
          selected={
            field.key === "status" && view
              ? statusKeys(view.columns, search.status).join(",")
              : undefined
          }
          onPick={(value) => set(field.key, value)}
          onRemove={() => set(field.key, undefined)}
        />
      ))}
    </div>
  );
}
