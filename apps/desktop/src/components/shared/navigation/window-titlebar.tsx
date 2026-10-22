// The window's title bar: one row across the whole window, the way Codex has
// it. The window controls and the shell's own buttons sit on the left, and on
// the right whatever the open page puts there through `<WindowTitlebar>`.
//
// The slot is kept here, in a module, not in a context of the app shell: the
// Settings shell hosts the same bar with no `AppShell` above it, and a page
// must not care which of the two it was drawn under.
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/utils";

/**
 * The slot of the one host mounted now.
 *
 * NOTE: One host at a time. A second one mounting (a route swap between the
 * two shells) takes the slot over, and a host gives it up only if it still
 * holds it. So the leaving shell's unmount, which React may run after the
 * arriving shell's mount, never empties the new bar.
 */
let current: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setSlot(next: HTMLElement | null) {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSlot = () => current;
const getServerSlot = () => null;

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
   * Settings' project picker, on every settings page.
   *
   * NOTE: React's own child of the slot, so it is in the DOM before any
   * page's portal is appended after it. A portal of the shell's would land on
   * whichever side mounted last.
   */
  lead?: ReactNode;
}) {
  // React 19 runs the ref's cleanup on unmount, with the node it attached.
  const slotRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setSlot(node);
    return () => {
      if (current === node) setSlot(null);
    };
  }, []);
  return (
    <div
      data-slot="window-titlebar"
      className={cn("window-titlebar window-drag-region", className)}
      style={style}
    >
      {children}
      <div ref={slotRef} className="window-titlebar-slot">
        {lead}
      </div>
    </div>
  );
}

/**
 * The page's name in the title bar: one size and weight on every page, so
 * moving between them never makes the title jump.
 */
export const WINDOW_TITLE =
  "min-w-0 truncate text-[15px] font-semibold tracking-tight";

/**
 * Put the page's header in the window's title bar.
 *
 * The children are laid out as one flex row that fills the slot (centred
 * vertically, `gap-2`, `min-w-0` so a `truncate` title can shrink).
 * `className` adds to it, e.g. `justify-between` for a title on the left and
 * actions on the right. Nothing is drawn until a host has mounted, and a page
 * that renders none leaves the slot empty.
 */
export function WindowTitlebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const slot = useSyncExternalStore(subscribe, getSlot, getServerSlot);
  if (!slot) return null;
  return createPortal(
    <div
      className={cn("flex h-full min-w-0 flex-1 items-center gap-2", className)}
    >
      {children}
    </div>,
    slot,
  );
}
