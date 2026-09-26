import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
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
 * A scroll area of rail rows with ONE hover background that slides from row to
 * row, rather than each row lighting on its own.
 *
 * ⚠️ Arriving from outside, it appears where the pointer is — only a move
 * BETWEEN rows slides. A highlight that flew in from wherever it last was
 * would be motion nobody asked for.
 *
 * ⚠️ Measured in the scroll area's CONTENT coordinates (plus `scrollTop`), so
 * the background scrolls with its row instead of staying on the screen.
 *
 * ⚠️ Rows are `relative` (see `ROW`): positioned and later in the DOM, they
 * paint over this background, which is the first child.
 */
export function RailHover({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [visible, setVisible] = useState(false);
  const [entering, setEntering] = useState(true);
  const reduced = useReducedMotion();

  const onPointerOver = (event: React.PointerEvent) => {
    const container = area.current;
    const row = (event.target as Element).closest(`.${RAIL_ROW}`);
    if (!container || !row || !container.contains(row)) return;
    const outer = container.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    setEntering(!visible);
    setVisible(true);
    setBox({
      x: inner.left - outer.left + container.scrollLeft,
      y: inner.top - outer.top + container.scrollTop,
      width: inner.width,
      height: inner.height,
    });
  };

  const jump = reduced || entering;
  return (
    <div
      ref={area}
      className={cn("relative", className)}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setVisible(false)}
    >
      {box && (
        <motion.div
          aria-hidden="true"
          data-testid="rail-hover"
          className="bg-foreground/[0.04] pointer-events-none absolute top-0 left-0 rounded-md"
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
