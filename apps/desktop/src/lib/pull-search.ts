// What the pull request URL carries, and how a stranger's link is read.
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
