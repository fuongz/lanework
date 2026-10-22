// A tag drawn as the label the board named it.
//
// NOTE: A tag with no label row is normal and still renders, neutral, with the
// tag as its own text. The vocabulary is a palette, not a whitelist: the
// service accepts any tag, imports bring over tags nobody has coloured, and a
// chip that appeared only for known labels would hide data the board stores.
import type { BoardLabel } from "#/../shared/workspaces";
import { cn } from "#/lib/utils";

export const labelOf = (
  labels: BoardLabel[],
  tag: string,
): BoardLabel | undefined => labels.find((label) => label.key === tag);

/**
 * A tone as the dot's colour.
 *
 * NOTE: A literal map, not `` `bg-tone-${tone}` ``. Tailwind reads source text
 * to decide what CSS to emit, so an interpolated class name produces none, and
 * the failure is an invisible dot rather than an error. Same reason
 * `glyphs.tsx` writes its map out.
 */
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

export function LabelChip({
  tag,
  labels,
  onRemove,
  className,
}: {
  tag: string;
  labels: BoardLabel[];
  onRemove?: () => void;
  className?: string;
}) {
  const label = labelOf(labels, tag);
  return (
    <span
      className={cn(
        "border-border bg-foreground/[0.02] inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border pr-2 pl-2 text-xs",
        className,
      )}
    >
      {/* A dot beside the text rather than a tinted pill. The tones are 3:1
          non-text contrast, so filling the chip with one and putting the name
          on top would put readable text below 4.5:1 for half the palette. */}
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          TONE_DOT[label?.tone ?? "neutral"] ?? TONE_DOT.neutral,
        )}
      />
      <span className="truncate">{label?.name ?? tag}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          // The label's name, not "remove": on a card with four chips, four
          // buttons all called "Remove label" name nothing.
          aria-label={`Remove ${label?.name ?? tag}`}
          className="text-muted-foreground hover:text-foreground -mr-1 px-1 leading-none transition-colors"
        >
          ×
        </button>
      )}
    </span>
  );
}
