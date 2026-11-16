import { cn } from "#/lib/utils";

/** Below this a reading is the room, drawn as a dot rather than a bar. */
const QUIET = 0.08;

/** The tallest reading, in px: every bar is this tall, scaled down. */
const BAR_PX = 18;

/**
 * The microphone's level as a strip of dots and bars moving right to left.
 *
 * The composer draws it in its own colour, the island in red.
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
          // A full-height bar scaled to the reading: `scaleY` composites,
          // where a changing height re-laid out every bar each reading.
          style={{
            transform: `scaleY(${(level < QUIET ? 2 : 4 + level * 14) / BAR_PX})`,
          }}
          className={cn(
            "h-[18px] w-[2px] rounded-full bg-current transition-transform duration-75",
            level < QUIET && quietClassName,
          )}
        />
      ))}
    </div>
  );
}
