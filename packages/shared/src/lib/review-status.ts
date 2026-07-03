import {
  DashedLineCircleIcon,
  Progress03Icon,
  CheckmarkCircle02Icon,
  Archive02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReviewColumn } from "./github";

export interface StatusMeta {
  label: string;
  icon: IconSvgElement;
  /** Tailwind text color for the icon. */
  color: string;
}

/** Single source of truth for how each review status looks (label + icon + color). */
export const STATUS_META: Record<ReviewColumn, StatusMeta> = {
  todo: { label: "To-Do", icon: DashedLineCircleIcon, color: "text-amber-500" },
  processing: { label: "In Progress", icon: Progress03Icon, color: "text-blue-500" },
  done: { label: "Done", icon: CheckmarkCircle02Icon, color: "text-emerald-500" },
  // `dropped` is the underlying status value (kept for back-compat); shown as "Archived".
  dropped: { label: "Archived", icon: Archive02Icon, color: "text-zinc-500" },
};

/**
 * A column's display meta, honouring a board's optional `status.labels`
 * override (`.agents/reviews/config.json`) so a client's own vocabulary (e.g.
 * "In Review" instead of "In Progress") shows on the board. Icon/color are
 * always the fixed defaults — only the label text is configurable.
 */
export function statusMeta(column: ReviewColumn, labels?: Partial<Record<ReviewColumn, string>>): StatusMeta {
  const label = labels?.[column];
  return label ? { ...STATUS_META[column], label } : STATUS_META[column];
}
