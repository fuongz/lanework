import { type GroupBy, isGroupBy } from "./board-view";

/** The view state a URL carries. Every field optional; every field a plain string. */
export interface IssueSearch {
  group?: GroupBy;
  status?: string;
  category?: string;
  priority?: string;
  tag?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= 200
    ? value
    : undefined;

const PRIORITIES = ["high", "medium", "low", "none"];

/**
 * Read a URL's view state, forgivingly.
 *
 * NOTE: Unknown values are DROPPED rather than rejected. A validator that
 * throws turns a stale bookmark — or a link from a build that had one more
 * filter, such as `?view=board` — into a router error page, and there is
 * nothing the reader can do about it. Falling back to the default view shows
 * them their board.
 *
 * It also takes any search object, so a page whose own URL carries more (New
 * issue's prefill) can hand back just the list's part of it.
 */
export function parseIssueSearch(raw: Record<string, unknown>): IssueSearch {
  const priority = text(raw.priority);
  return {
    group: isGroupBy(raw.group) ? raw.group : undefined,
    status: text(raw.status),
    category: text(raw.category),
    priority: priority && PRIORITIES.includes(priority) ? priority : undefined,
    tag: text(raw.tag),
  };
}
