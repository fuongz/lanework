// The window's title bar: one row across the whole window, the way Codex has
// it. The window controls and the shell's own buttons sit on the left, then
// the shell's `lead` (the session tabs).
//
// A page's own header is no longer put in it: `<WindowTitlebar>` draws at the
// top of the page's card (FE-144).
import type { CSSProperties, ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * The bar itself, for a shell to draw at the top of the window.
 *
 * Laid out by app.css (`.window-titlebar`) from two lengths a shell can set
 * on it, both in the window's CSS px:
 * - `--titlebar-split`: where the rail ends; the slot starts after it.
 *   Defaults to `--rail-width`, the app rail's drawn width.
 * - `--titlebar-slot-start`: where the slot's clearance ends, when something
 *   besides the rail (the back/forward group) reaches further. Defaults to
 *   the split.
 *
 * A window drag region: what a page puts in the slot drags the window from
 * its empty space, and its buttons, links and fields stay clickable through
 * the `.window-drag-region a, button, …` rules.
 */
export function WindowTitlebarHost({
  className,
  style,
  children,
  lead,
}: {
  className?: string;
  style?: CSSProperties;
  /** The shell's own pieces of the bar, drawn before the slot. */
  children?: ReactNode;
  /**
   * Drawn at the start of the slot, before whatever the page puts there:
   * the app shell's session tabs.
   *
   * NOTE: React's own child of the slot, so it is in the DOM before any
   * page's portal is appended after it. A portal of the shell's would land on
   * whichever side mounted last.
   */
  lead?: ReactNode;
}) {
  return (
    <div
      data-slot="window-titlebar"
      className={cn("window-titlebar window-drag-region", className)}
      style={style}
    >
      {children}
      <div className="window-titlebar-slot">{lead}</div>
    </div>
  );
}

/**
 * The page's name in the title bar: one size and weight on every page, so
 * moving between them never makes the title jump.
 */
export const WINDOW_TITLE = "min-w-0 truncate text-[14px] font-semibold";

/**
 * The page's header, at the top of its card (FE-144).
 *
 * It used to be portalled into the window's title bar; the title bar now
 * holds the session tabs, and each page heads its own card. One row: centred
 * vertically, `gap-2`, `min-w-0` so a `truncate` title can shrink, the same
 * 48px height and 20px inset on every page. `className` adds to it, e.g.
 * `justify-between` for a title on the left and actions on the right.
 *
 * NOTE: The name is kept so the pages did not have to change; it draws in
 * place, where the page puts it, so it must sit in a column (a page's
 * `flex-col` root) to read as a header.
 */
export function WindowTitlebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex h-12 min-w-0 shrink-0 items-center gap-2 px-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
