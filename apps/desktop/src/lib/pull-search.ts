// What the pull request URLs carry, the list's and one pull request's, and
// how a stranger's link is read.
//
// NOTE: This lives here, not beside the list it filters, because the route
// needs it: `validateSearch` runs before any component mounts. A parser
// exported from `pulls-list.tsx` would make that file imported from two
// places — the route and the layout — and `audit-layout` calls a
// twice-imported feature component a shared one.
import { PULL_STATUSES, type PullStatus } from "../../shared/git";

export const PULL_TABS = ["all", "reviewing", "authored"] as const;
export type PullTab = (typeof PULL_TABS)[number];

export interface PullSearch {
  tab: PullTab;
  status: PullStatus;
}

/**
 * Reads the pull request view from a URL's search.
 *
 * Unknown values fall back rather than throw: a link from an older build must
 * still open.
 */
export function parsePullSearch(raw: Record<string, unknown>): PullSearch {
  const tab = raw.tab;
  const status = raw.status;
  return {
    tab: PULL_TABS.includes(tab as PullTab) ? (tab as PullTab) : "all",
    status: PULL_STATUSES.includes(status as PullStatus)
      ? (status as PullStatus)
      : "open",
  };
}

/**
 * Which half of a pull request is on screen.
 *
 * `summary` is the default and is spelled by absence: the parser returns no
 * `view` for it. A pull request opens on what it is before what changed in
 * it, and `view` in a link means someone chose the code, not that a default
 * got written down.
 */
export type PullView = "summary" | "code";
export interface PullDetailSearch {
  view?: PullView;
}

export function parsePullDetailSearch(
  raw: Record<string, unknown>,
): PullDetailSearch {
  return raw.view === "code" ? { view: "code" } : {};
}
