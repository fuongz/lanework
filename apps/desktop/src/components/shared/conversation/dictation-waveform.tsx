import { cn } from "#/lib/utils";

/** Below this a reading is the room, drawn as a dot rather than a bar. */
const QUIET = 0.08;

/**
 * The microphone's level as a strip of dots and bars moving right to left
 * (FE-69): the composer draws it in its own colour, the island in red.
 */
export function DictationWaveform({
  levels,
  className,
  quietClassName = "opacity-50",
}: {
  levels: number[];
  /** The bars' colour, as a text colour: they are `bg-current`. */
  className?: string;
  /** How a dot for a quiet reading differs from a bar. */
  quietClassName?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex h-5 items-center gap-[3px]", className)}
    >
      {levels.map((level, index) => (
        <span
          // A strip of fixed slots: the readings move through them.
          // biome-ignore lint/suspicious/noArrayIndexKey: slots, not items.
          key={index}
          style={{
            height: level < QUIET ? 2 : `${Math.round(4 + level * 14)}px`,
          }}
          className={cn(
            "w-[2px] rounded-full bg-current transition-[height] duration-75",
            level < QUIET && quietClassName,
          )}
        />
      ))}
    </div>
  );
}
