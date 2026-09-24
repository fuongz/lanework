import { type GroupBy, isGroupBy } from "./board-view";

/** How a project's issues are drawn: rows, or lanes (FE-13/D4). */
export type IssueView = "list" | "board";

/** The view state a URL carries. Every field optional; every field a plain string. */
export interface IssueSearch {
  /**
   * Absent means the list. Only `"board"` is ever written, so the list's URL
   * stays the bare one every older link already points at.
   */
  view?: "board";
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
 * ⚠️ Unknown values are DROPPED rather than rejected. A validator that throws
 * turns a stale bookmark — or a link from a build that had one more filter —
 * into a router error page, and there is nothing the reader can do about it.
 * Falling back to the default view shows them their board.
 */
export function parseIssueSearch(raw: Record<string, unknown>): IssueSearch {
  const priority = text(raw.priority);
  return {
    view: raw.view === "board" ? "board" : undefined,
    group: isGroupBy(raw.group) ? raw.group : undefined,
    status: text(raw.status),
    category: text(raw.category),
    priority: priority && PRIORITIES.includes(priority) ? priority : undefined,
    tag: text(raw.tag),
  };
}
