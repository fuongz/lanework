import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "#/lib/utils";

/** One digit's flip: quick, settling without a bounce. */
const FLIP = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * A short text whose digits flip, split-flap style, when they change: the
 * old one turns up and away, the new one turns in from below. The chat's
 * running clock ("1m 24s").
 *
 * - Keyed from the right, so as "59s" becomes "1m 00s" the units stay put
 *   and only what changed turns.
 * - Letters and spaces are drawn still; only digits flip.
 * - Reduced motion: plain text.
 */
export function RollingText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  if (reduced)
    return <span className={cn("tabular-nums", className)}>{text}</span>;
  const chars = [...text];
  return (
    <span
      className={cn("inline-flex tabular-nums", className)}
      style={{ perspective: 400 }}
    >
      <span className="sr-only">{text}</span>
      {chars.map((char, index) => {
        const key = chars.length - index;
        if (!/\d/.test(char))
          return (
            <span key={key} aria-hidden="true" className="whitespace-pre">
              {char}
            </span>
          );
        return (
          <span
            key={key}
            aria-hidden="true"
            className="relative inline-flex overflow-hidden"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={char}
                className="inline-block"
                style={{ transformOrigin: "50% 50% -0.5em" }}
                initial={{ rotateX: -90, opacity: 0 }}
                animate={{ rotateX: 0, opacity: 1 }}
                exit={{ rotateX: 90, opacity: 0 }}
                transition={FLIP}
              >
                {char}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}
