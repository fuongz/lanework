import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useId } from "react";
import { cn } from "#/lib/utils";

/** One choice in a {@link SegmentedControl}. */
interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconSvgElement;
}

/**
 * A pill that slides between two or three choices; every switch in the app
 * wears this shape.
 *
 * One component, three ARIA readings, because the controls using it mean
 * different things even though they look alike:
 * - `pressed`: how this region is drawn (List/Board, Split/Unified); buttons
 *   with `aria-pressed`.
 * - `tabs`: which panel is shown (a pull request's Summary/Code); a real
 *   `tablist`.
 * - `current`: which slice of a list the URL is on (All/Reviewing/Authored);
 *   `aria-current`, the way the rail marks where you are.
 *
 * The pill is a shared `layoutId`, scoped by `useId` so two switches on one
 * screen never trade pills. It glides only while the control stays mounted,
 * so callers keep it in a bar that survives the switch.
 * `MotionConfig reducedMotion="user"` at the root turns the glide into a jump.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  semantics = "pressed",
  className,
  layoutId,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label: string;
  semantics?: "pressed" | "tabs" | "current";
  className?: string;
  /**
   * The pill's shared id, for a switch drawn by two screens in turn.
   *
   * The same id on both (Issues and Pull requests) lets the pill glide from
   * one screen's copy to the next instead of appearing in place.
   */
  layoutId?: string;
}) {
  const pill = useId();
  // Spread, so each role gets the ARIA attributes it supports and no others:
  // a `tablist` names itself, a `tab` is selected, a button is pressed or
  // current.
  const group =
    semantics === "tabs"
      ? { role: "tablist" as const, "aria-label": label }
      : { role: "group" as const, "aria-label": label };
  return (
    <div
      {...group}
      className={cn(
        "bg-foreground/[0.05] flex w-fit items-center gap-0.5 rounded-full p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const on = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            {...(semantics === "tabs"
              ? { role: "tab" as const, "aria-selected": on }
              : semantics === "pressed"
                ? { "aria-pressed": on }
                : { "aria-current": on ? ("page" as const) : undefined })}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
            className={cn(
              "focus-visible:ring-ring/40 relative flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2",
              on
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={layoutId ?? pill}
                aria-hidden="true"
                className="bg-background dark:bg-foreground/15 absolute inset-0 rounded-full shadow-sm"
                transition={{ type: "spring", duration: 0.35, bounce: 0.18 }}
              />
            )}
            {option.icon && (
              <HugeiconsIcon
                icon={option.icon}
                className="relative size-3.5"
                strokeWidth={1.6}
                aria-hidden="true"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
