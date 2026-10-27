/**
 * The menu glass: a thin tint over a heavy blur, a hairline rim and a lit top
 * edge.
 *
 * What is under a menu shows through, blurred, instead of a near-solid card.
 * The blur sits on `::before` so the popup's own scroll clip never cuts it
 * off. No open/close animation, as `DropdownMenuContent` has none: every
 * menu appears and goes the same way.
 *
 * NOTE: A local edit to vendored code, kept in `components/ui/` on purpose.
 * `popover.tsx`, `dropdown-menu.tsx` and `context-menu.tsx` import it, so
 * re-adding any of them with `shadcn add --overwrite` drops the glass
 * silently: the file still builds, the menus just turn back into solid
 * cards. After such a sync, put the `MENU_SURFACE` import and its class
 * back in each popup.
 */
export const MENU_SURFACE =
  "relative rounded-xl bg-popover/40 dark:bg-muted/45 ring-1 ring-foreground/12 dark:ring-foreground/15 shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45),inset_0_1px_0_0_rgb(255_255_255/0.06)] before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-3xl before:backdrop-saturate-[1.8] animate-none!";
