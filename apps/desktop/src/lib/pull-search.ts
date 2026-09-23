/**
 * What the pull request URL carries, and how a stranger's link is read.
 *
 * ⚠️ It lives here rather than beside the list it filters because the ROUTE
 * needs it: `validateSearch` runs before any component mounts. A parser
 * exported from `pulls-list.tsx` made that file something two places import —
 * the route for this function, the layout for the list — and `audit-layout`
 * calls a twice-imported feature component a shared one.
 */
import { PULL_STATUSES, type PullStatus } from "../../shared/git";

export const PULL_TABS = ["all", "reviewing", "authored"] as const;
export type PullTab = (typeof PULL_TABS)[number];

export interface PullSearch {
  tab: PullTab;
  status: PullStatus;
}

/** Unknown values fall back rather than throw: a link from an older build must still open. */
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
