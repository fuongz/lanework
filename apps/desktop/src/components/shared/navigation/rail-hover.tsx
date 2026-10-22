import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";

/** The class every rail row carries, so the hover can find the row it is on. */
export const RAIL_ROW = "rail-row";

const SPRING = {
  type: "spring",
  stiffness: 900,
  damping: 50,
  mass: 0.4,
} as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A scroll area of rail rows with one hover background that slides from row
 * to row, rather than each row lighting on its own.
 *
 * - Arriving from outside, it appears where the pointer is; only a move
 *   between rows slides. A highlight that flew in from wherever it last was
 *   would be motion nobody asked for.
 * - Measured in the scroll area's content coordinates (plus `scrollTop`), so
 *   the background scrolls with its row instead of staying on the screen.
 * - NOTE: Rows are `relative` (see `ROW`): positioned and later in the DOM,
 *   they paint over this background, which is the first child.
 */
export function RailHover({
  className,
  backgroundClassName,
  children,
}: {
  className?: string;
  backgroundClassName?: string;
  children: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [visible, setVisible] = useState(false);
  const [entering, setEntering] = useState(true);
  const reduced = useReducedMotion();

  // Keyboard navigation keeps the primitive's own focus/selection background.
  useEffect(() => {
    if (!visible) return;
    const hide = () => setVisible(false);
    document.addEventListener("keydown", hide);
    return () => document.removeEventListener("keydown", hide);
  }, [visible]);

  const onPointerOver = (event: React.PointerEvent) => {
    const container = area.current;
    const row = (event.target as Element).closest(`.${RAIL_ROW}`);
    if (!container || !row || !container.contains(row)) return;
    if (
      row.matches(
        '[data-disabled]:not([data-disabled="false"]), [aria-disabled="true"], :disabled',
      )
    )
      return;
    const outer = container.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    setEntering(!visible);
    setVisible(true);
    setBox({
      x: inner.left - outer.left - container.clientLeft + container.scrollLeft,
      y: inner.top - outer.top - container.clientTop + container.scrollTop,
      width: inner.width,
      height: inner.height,
    });
  };

  const jump = reduced || entering;
  return (
    <div
      ref={area}
      data-slot="rail-hover-area"
      data-hovering={visible ? "true" : undefined}
      className={cn("relative", className)}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setVisible(false)}
    >
      {box && (
        <motion.div
          aria-hidden="true"
          data-testid="rail-hover"
          className={cn(
            "bg-foreground/[0.04] pointer-events-none absolute top-0 left-0 rounded-md",
            backgroundClassName,
          )}
          initial={false}
          animate={{ ...box, opacity: visible ? 1 : 0 }}
          transition={{
            default: jump ? { duration: 0 } : SPRING,
            opacity: { duration: reduced ? 0 : 0.1 },
          }}
        />
      )}
      {children}
    </div>
  );
}
