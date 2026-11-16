import type { ComponentProps } from "react";

/**
 * Stop, filled: a solid rounded square, read at a glance as "stop" where an
 * outlined square reads as an empty box. Sized like a Hugeicons icon (a
 * button's `[&_svg]` rule, or a `size-*` class) and drawn in `currentColor`.
 */
export function StopGlyph(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor" />
    </svg>
  );
}
