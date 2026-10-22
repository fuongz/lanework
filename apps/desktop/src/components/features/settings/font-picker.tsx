import { UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/shared/navigation/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "#/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { type FontCatalog, type FontStyle, loadFontCatalog } from "#/lib/fonts";
import { type FontRole, usePreferences } from "#/stores/preferences";

const DEFAULT_LABEL: Record<FontRole, string> = {
  ui: "Default",
  content: "Same as UI font",
  code: "Default",
};

/**
 * The installed fonts, for every picker on the page.
 *
 * NOTE: Read on mount and again when a picker opens. The first read can be
 * refused for want of a user gesture, and opening a picker is one.
 */
function useFontCatalog() {
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    loadFontCatalog().then(
      (fonts) => {
        setCatalog(fonts);
        setFailed(false);
      },
      () => setFailed(true),
    );
  };
  // Once per mount; `load` only sets state.
  useEffect(load, []);
  const retry = () => {
    if (!catalog) load();
  };
  return { catalog, failed, retry };
}

/** The style closest to `weight`, which a newly picked family starts on. */
function closest(styles: FontStyle[], weight: number): FontStyle | undefined {
  return styles.reduce<FontStyle | undefined>(
    (best, style) =>
      !best || Math.abs(style.weight - weight) < Math.abs(best.weight - weight)
        ? style
        : best,
    undefined,
  );
}

/**
 * A family and a style of it, for one of the three font roles.
 *
 * The style select is disabled while the role is at its default: there is no
 * family to list styles of, and the default's weight is the app's.
 */
export function FontPicker({
  font: role,
  label,
}: {
  font: FontRole;
  label: string;
}) {
  const choice = usePreferences((state) => state.fonts[role]);
  const setFont = usePreferences((state) => state.setFont);
  const { catalog, failed, retry } = useFontCatalog();

  const families = catalog ?? [];
  // A saved family this machine no longer has still shows as picked, so the
  // select does not read "Default" over a setting that is in force.
  const listed = choice && !families.some((f) => f.family === choice.family);
  const styles: FontStyle[] = choice
    ? (families.find((f) => f.family === choice.family)?.styles ?? [
        { style: choice.style, weight: choice.weight },
      ])
    : [];

  const names = families.map((f) => f.family);

  const pickFamily = (family: string | null) => {
    if (family === null) return setFont(role, null);
    const offered = families.find((f) => f.family === family)?.styles ?? [];
    const style = closest(offered, choice?.weight ?? 400);
    if (style) setFont(role, { family, ...style });
  };

  const pickStyle = (style: string) => {
    const picked = styles.find((s) => s.style === style);
    if (choice && picked) setFont(role, { ...choice, ...picked });
  };

  return (
    <div className="flex items-center gap-2">
      <FamilyCombobox
        label={label}
        defaultLabel={DEFAULT_LABEL[role]}
        value={choice?.family ?? null}
        families={listed ? [choice.family, ...names] : names}
        loading={!catalog && !failed}
        failed={failed}
        onOpen={retry}
        onPick={pickFamily}
      />

      <Select
        value={choice?.style ?? ""}
        onValueChange={(value) => pickStyle(value as string)}
      >
        <SelectTrigger
          aria-label={`${label} style`}
          disabled={!choice}
          className="w-28"
        >
          <SelectValue>
            {(value: string) => (choice ? value : "Regular")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {styles.map(({ style }) => (
            <SelectItem key={style} value={style}>
              {style}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The family picker, a searchable list.
 *
 * A Mac has hundreds of families, and a plain select only scrolls. The
 * default sits in its own group above a separator: it is not a font, so it is
 * not sorted among them or matched by a search.
 */
function FamilyCombobox({
  label,
  defaultLabel,
  value,
  families,
  loading,
  failed,
  onOpen,
  onPick,
}: {
  label: string;
  defaultLabel: string;
  value: string | null;
  families: string[];
  loading: boolean;
  failed: boolean;
  onOpen: () => void;
  onPick: (family: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? families.filter((family) => family.toLowerCase().includes(needle))
    : families;

  const pick = (family: string | null) => {
    onPick(family);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
        else setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label={`${label} family`}
            className="border-input bg-input/20 hover:bg-input/40 dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/30 flex h-7 max-w-48 items-center gap-1.5 rounded-md border px-2 text-xs/relaxed whitespace-nowrap outline-none focus-visible:ring-2"
          >
            <span className="truncate">{value ?? defaultLabel}</span>
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              strokeWidth={2}
              className="text-muted-foreground size-3.5 shrink-0"
            />
          </button>
        }
      />
      <PopoverContent variant="menu" align="end">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search fonts"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-80">
            {needle ? null : (
              <>
                <CommandGroup className="p-0">
                  <CommandItem
                    value={"\u0000default"}
                    data-checked={value === null ? "true" : undefined}
                    onSelect={() => pick(null)}
                  >
                    {defaultLabel}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {loading ? (
              <ListSkeleton label="Loading fonts" rows={5} icon={false} />
            ) : failed ? (
              <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                Couldn’t read this Mac’s fonts.
              </p>
            ) : (
              <CommandEmpty>No fonts match.</CommandEmpty>
            )}
            {matched.map((family) => (
              <CommandItem
                key={family}
                value={family}
                data-checked={value === family ? "true" : undefined}
                onSelect={() => pick(family)}
              >
                <span className="truncate">{family}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
