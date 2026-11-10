import {
  Alert02Icon,
  Cancel01Icon,
  InformationCircleIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "#/lib/utils";
import type { NotifyType } from "#/stores/notify";

/**
 * Each tone's glyph and colour, for the island's black surface in both themes.
 *
 * The weights are the other islands': 2.4 for the tick and the cross, which
 * read thin at 14px, and 2 for the rest.
 */
const GLYPHS = {
  success: { icon: Tick02Icon, color: "text-emerald-400", stroke: 2.4 },
  error: { icon: Cancel01Icon, color: "text-red-400", stroke: 2.4 },
  warning: { icon: Alert02Icon, color: "text-amber-400", stroke: 2 },
  info: { icon: InformationCircleIcon, color: "text-sky-400", stroke: 2 },
} as const;

/**
 * A toast's status glyph; loading spins.
 *
 * Decorative: the title beside it, and the live region, say the status.
 */
export function NotifyIcon({
  type,
  className,
}: {
  type: NotifyType;
  className?: string;
}) {
  if (type === "loading")
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        className={cn(
          "size-3.5 shrink-0 animate-spin text-white/80 motion-reduce:animate-none",
          className,
        )}
        strokeWidth={2}
        aria-hidden="true"
      />
    );
  const glyph = GLYPHS[type];
  return (
    <HugeiconsIcon
      icon={glyph.icon}
      className={cn("size-3.5 shrink-0", glyph.color, className)}
      strokeWidth={glyph.stroke}
      aria-hidden="true"
    />
  );
}
