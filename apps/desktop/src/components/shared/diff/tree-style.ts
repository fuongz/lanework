import type { CSSProperties } from "react";
import { TREE_ICON_TONES } from "./diff-icons";

/**
 * App tokens, poured into `@pierre/trees`' own variables.
 *
 * Shared by the pull request's changed files and Repository › Files. Every
 * one is an OVERRIDE the library documents, set on the host element: custom
 * properties inherit through a shadow boundary, and an inline style on the
 * host beats the `:host` rule that declares the default.
 *
 * NOTE: `colorScheme` is here for the same reason `useDark` exists: the
 * library's defaults are `light-dark()` values, `light-dark()` reads
 * `color-scheme`, and `color-scheme` follows the OS, which this window's theme
 * does not (see `use-theme.ts`). Without it the tree renders a light palette
 * inside a dark window.
 */
export function treeHostStyle(dark: boolean): CSSProperties {
  return {
    ...TREE_ICON_TONES,
    colorScheme: dark ? "dark" : "light",
    "--trees-bg-override": "var(--color-sidebar)",
    "--trees-fg-override": "var(--color-foreground)",
    "--trees-fg-muted-override": "var(--color-muted-foreground)",
    "--trees-accent-override": "var(--color-accent-brand)",
    "--trees-border-color-override": "var(--color-sidebar-border)",
    "--trees-focus-ring-color-override": "var(--color-accent-brand)",
    "--trees-font-family-override": "inherit",
    "--trees-font-size-override": "12px",
    // 8px rather than 16. The pane is 240px, and every one of those pixels is a
    // character of a filename at the bottom of a deep path.
    "--trees-padding-inline-override": "8px",
    "--trees-status-added-override": "var(--color-tone-emerald)",
    "--trees-status-deleted-override": "var(--color-tone-rose)",
    "--trees-status-modified-override": "var(--color-tone-amber)",
    "--trees-status-renamed-override": "var(--color-tone-violet)",
    "--trees-status-untracked-override": "var(--color-tone-emerald)",
    "--trees-status-ignored-override": "var(--color-tone-neutral)",
  } as CSSProperties;
}

/** A closed folder, filled; drawn as a mask, so it takes the row's colour. */
const FOLDER_CLOSED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.38a1.5 1.5 0 0 1 1.06.44L8.62 3.6H13a1.5 1.5 0 0 1 1.5 1.5v6.9A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z"/></svg>';

/** The same folder, open: its back panel and a front flap tipped forward. */
const FOLDER_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.38a1.5 1.5 0 0 1 1.06.44L8.62 3.6H12a1.5 1.5 0 0 1 1.5 1.5V6H4.6a1.5 1.5 0 0 0-1.42 1.02L1.5 12.2z"/><path d="M3.9 7.3a1 1 0 0 1 .95-.7h9.4a.75.75 0 0 1 .71.99l-1.6 5.07a1.2 1.2 0 0 1-1.14.84H2.3a.5.5 0 0 1-.47-.66z"/></svg>';

const mask = (svg: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/**
 * Folders drawn as folders, closed or open, in place of the library's chevron.
 *
 * Open and closed already say what the chevron said, and a folder's icon then
 * lines up with its files' icons instead of one column to their left.
 *
 * CSS, because `@pierre/trees` has no folder icon slot: a directory row's
 * icon section only ever holds the chevron (`remap` can change that glyph,
 * but not by state). The chevron is hidden and a mask drawn in its place,
 * switched on the row's own `aria-expanded`. NOTE: A sticky folder row
 * carries no `aria-expanded`; it is sticky because it is open.
 */
export const FOLDER_ICON_CSS = `
[data-item-type="folder"] > [data-item-section="icon"] > [data-icon-name="file-tree-icon-chevron"] {
  display: none;
}
[data-item-type="folder"] > [data-item-section="icon"]::before {
  content: "";
  width: 14px;
  height: 14px;
  background-color: currentColor;
  mask: ${mask(FOLDER_CLOSED)} center / contain no-repeat;
}
[data-item-type="folder"][aria-expanded="true"] > [data-item-section="icon"]::before,
[data-item-type="folder"][data-file-tree-sticky-row="true"] > [data-item-section="icon"]::before {
  mask-image: ${mask(FOLDER_OPEN)};
}
`;

/**
 * A folder with a status of its own (the strongest change inside it), coloured
 * whole.
 *
 * Its folder icon takes the status colour as its name does. In the git lane
 * it keeps a DOT rather than the file's letter: "M" beside a folder reads as
 * a folder that was modified, and nothing happened to it.
 */
export const FOLDER_STATUS_CSS = `
[data-item-type="folder"][data-item-git-status]:not([data-item-git-status="ignored"]) > [data-item-section="icon"] {
  color: var(--trees-item-git-status-color);
}
[data-item-type="folder"][data-item-git-status]:not([data-item-git-status="ignored"]) > [data-item-section="git"] > span {
  font-size: 0;
}
[data-item-type="folder"][data-item-git-status]:not([data-item-git-status="ignored"]) > [data-item-section="git"] > span::after {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
}
`;

/**
 * A denser tree for Repository › Files.
 *
 * 22px rows as an editor's explorer has them, a narrower icon column and
 * tighter indentation. NOTE: Paired with `density: "compact"` and
 * `itemHeight: 22` on the model, which own the row height the virtualizer
 * measures with.
 */
export const COMPACT_TREE_STYLE = {
  "--trees-icon-width-override": "14px",
  "--trees-item-row-gap-override": "5px",
  "--trees-item-padding-x-override": "6px",
  "--trees-level-gap-override": "6px",
  "--trees-border-radius-override": "4px",
} as CSSProperties;
