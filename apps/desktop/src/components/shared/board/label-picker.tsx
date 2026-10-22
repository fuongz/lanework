// Putting a label on a card: pick one the board already names, or type a new
// one.
//
// Both, in one menu. The board's vocabulary is a palette rather than a
// whitelist (the service accepts any tag), so a picker that only offered the
// named labels would make every free tag unreachable from this screen, and a
// plain text field would throw away the colours the board does define. The
// list is what a person reaches for; the field keeps the surface honest about
// what the board stores.
import { Add01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { type BoardLabel, normalizeTag } from "#/../shared/workspaces";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";

const TONE_DOT: Record<string, string> = {
  neutral: "bg-tone-neutral",
  violet: "bg-tone-violet",
  amber: "bg-tone-amber",
  blue: "bg-tone-blue",
  sky: "bg-tone-sky",
  emerald: "bg-tone-emerald",
  teal: "bg-tone-teal",
  rose: "bg-tone-rose",
  red: "bg-tone-rose",
};

export function LabelPicker({
  tags,
  labels,
  disabled = false,
  onChange,
}: {
  tags: string[];
  labels: BoardLabel[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const on = new Set(tags);

  const toggle = (tag: string) =>
    onChange(on.has(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);

  // NOTE: Splits on commas. A pasted "ui, electron" is how a list arrives, and
  // `normalizeTag` turns spaces into hyphens rather than stripping commas, so
  // the whole string would otherwise become the single tag `ui,-electron`.
  const commit = () => {
    const next = [...tags];
    for (const part of draft.split(",")) {
      const tag = normalizeTag(part);
      if (!tag || next.includes(tag)) continue;
      next.push(tag);
    }
    setDraft("");
    if (next.length !== tags.length) onChange(next);
  };

  // Tags the card wears that the board has not named, shown so they can be
  // taken off from the same menu they would be added in.
  const unnamed = tags.filter((tag) => !labels.some((l) => l.key === tag));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-accent-brand inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-xs transition-colors focus-visible:ring-2 disabled:opacity-50"
      >
        <HugeiconsIcon icon={Add01Icon} className="size-3.5" strokeWidth={2} />
        Add label
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <div className="p-1">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="New label…"
            aria-label="New label"
            className="h-7 text-[13px]"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                return;
              }
              // NOTE: Escape and Tab are the menu's, and they have to reach it.
              // Stopped here, the picker stays open over the page with the
              // caret in this field, and every click after it (Save, the next
              // rail row) hits the menu's backdrop instead. A field inside a
              // menu owns its typing, not its exits.
              if (event.key === "Escape" || event.key === "Tab") return;
              // Everything else is typing, and it must not reach the menu's own
              // typeahead, which would jump the highlight to whichever item
              // starts with that letter and take the caret out of this field.
              event.stopPropagation();
            }}
          />
        </div>
        {[...labels.map((l) => l.key), ...unnamed].map((tag) => {
          const label = labels.find((l) => l.key === tag);
          return (
            <DropdownMenuItem
              key={tag}
              // Putting three labels on a card is one task, and a menu that
              // shut after each one would make it three.
              closeOnClick={false}
              onClick={() => toggle(tag)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  TONE_DOT[label?.tone ?? "neutral"] ?? TONE_DOT.neutral,
                )}
              />
              <span className="truncate">{label?.name ?? tag}</span>
              {on.has(tag) && (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className="ml-auto size-4"
                  strokeWidth={2}
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
