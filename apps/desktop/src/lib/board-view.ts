// Everything the issue views need to decide WHAT to show, with no opinion
// about how it looks and no React. Grouping and filtering are easy to get
// subtly wrong and impossible to see wrong in a screenshot, so they live here
// where a test can hold them still.
import type {
  BoardCard,
  BoardCategory,
  BoardColumn,
  BoardView,
} from "../../shared/workspaces";

/** The axes a board can be grouped along. All three are fields cards carry. */
export const GROUP_BY = ["status", "category", "priority"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const isGroupBy = (value: unknown): value is GroupBy =>
  typeof value === "string" && (GROUP_BY as readonly string[]).includes(value);

/**
 * A filter, as it survives in the URL.
 *
 * One value per axis, except status: a comma-separated set of lane keys, and
 * `"none"` lets nothing through.
 */
interface IssueFilters {
  status?: string;
  category?: string;
  priority?: string;
  tag?: string;
}

interface IssueGroup {
  key: string;
  name: string;
  tone: string;
  /**
   * The lane's role when grouping by status: `done` and `archive` start
   * collapsed.
   */
  role: string | null;
  cards: BoardCard[];
}

/**
 * The order the status filter lists lanes in: the work being done first, then
 * what is next, then the rest.
 */
const ROLE_ORDER = ["active", "start", "intake", "done", "archive"];

const roleRank = (role: string | null) => {
  const at = ROLE_ORDER.indexOf(role ?? "");
  return at === -1 ? ROLE_ORDER.length : at;
};

/** Lanes in the status filter's order, ties kept in board order. */
export function byStatusOrder<T extends { role: string | null }>(
  columns: readonly T[],
): T[] {
  return columns
    .map((column, index) => ({ column, index }))
    .sort(
      (left, right) =>
        roleRank(left.column.role) - roleRank(right.column.role) ||
        left.index - right.index,
    )
    .map((entry) => entry.column);
}

/**
 * The lanes the list shows when the URL names none: everything not finished.
 *
 * Backlog, To-Do and In Progress on a default board.
 */
export function defaultStatusKeys(
  columns: readonly { key: string; role: string | null }[],
): string[] {
  return columns
    .filter((column) => column.role !== "done" && column.role !== "archive")
    .map((column) => column.key);
}

/**
 * The URL's status filter, as the lane keys it lets through.
 *
 * `undefined` is the default set; `"none"` is every box unticked.
 */
export function statusKeys(
  columns: readonly { key: string; role: string | null }[],
  status: string | undefined,
): string[] {
  if (status === undefined) return defaultStatusKeys(columns);
  if (status === "none") return [];
  const known = new Set(columns.map((column) => column.key));
  return status.split(",").filter((key) => known.has(key));
}

export const PRIORITY_GROUPS = [
  { key: "high", name: "High", tone: "rose" },
  { key: "medium", name: "Medium", tone: "amber" },
  { key: "low", name: "Low", tone: "sky" },
  { key: "none", name: "No priority", tone: "neutral" },
] as const;

/**
 * Cards in board order.
 *
 * `rank` is a fractional index, so it sorts as a plain string, never a number.
 */
export const byRank = (a: BoardCard, b: BoardCard): number =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id.localeCompare(b.id);

export function filterCards(
  cards: BoardCard[],
  filters: IssueFilters,
): BoardCard[] {
  return cards.filter(
    (card) =>
      (!filters.status || filters.status.split(",").includes(card.columnKey)) &&
      (!filters.category || card.categoryKey === filters.category) &&
      (!filters.priority ||
        (filters.priority === "none"
          ? card.priority === null
          : card.priority === filters.priority)) &&
      (!filters.tag || card.tags.includes(filters.tag)),
  );
}

/**
 * The board, cut into the groups one view renders.
 *
 * NOTE: EVERY group is returned, including empty ones, when grouping by
 * status. A lane that vanishes because nothing is in it makes a board look
 * like it has fewer states than it does, and on a board view an empty lane is
 * the only place a card can be dropped INTO. Grouping by category or priority
 * drops the empties: there the group is a property of the cards, not a shape
 * of the board.
 */
export function groupIssues(
  view: Pick<BoardView, "columns" | "categories" | "cards">,
  groupBy: GroupBy,
  filters: IssueFilters = {},
): IssueGroup[] {
  const cards = filterCards(view.cards, filters);
  const bucket = (key: string) =>
    cards.filter((card) => cardGroupKey(card, groupBy) === key).sort(byRank);

  if (groupBy === "status")
    return view.columns.map((column) => ({
      key: column.key,
      name: column.name,
      tone: column.tone,
      role: column.role,
      cards: bucket(column.key),
    }));

  if (groupBy === "priority")
    return PRIORITY_GROUPS.map((group) => ({
      key: group.key,
      name: group.name,
      tone: group.tone,
      role: null,
      cards: bucket(group.key),
    })).filter((group) => group.cards.length > 0);

  const groups: IssueGroup[] = view.categories.map((category) => ({
    key: category.key,
    name: category.name,
    tone: category.tone,
    role: null,
    cards: bucket(category.key),
  }));
  // NOTE: A card with no category is not invisible. The board mints task ids
  // from categories, so an uncategorised card is the one somebody still has
  // to file; dropping it from this view would hide the work it represents.
  const loose = bucket("none");
  if (loose.length)
    groups.push({
      key: "none",
      name: "No category",
      tone: "neutral",
      role: null,
      cards: loose,
    });
  return groups.filter((group) => group.cards.length > 0);
}

function cardGroupKey(card: BoardCard, groupBy: GroupBy): string {
  if (groupBy === "status") return card.columnKey;
  if (groupBy === "priority") return card.priority ?? "none";
  return card.categoryKey ?? "none";
}

/** The cards filed under one parent, in board order. */
export const subIssues = (cards: BoardCard[], parentId: string): BoardCard[] =>
  cards.filter((card) => card.parentId === parentId).sort(byRank);

/**
 * `2/5` for a card that has children, or null for one that has none.
 *
 * NOTE: "Done" is whichever lanes the BOARD gives the `done` role, not a lane
 * called "Done". A board that renamed its last lane still has one, and
 * counting by name would report every card on it as unfinished.
 */
export function subIssueProgress(
  cards: BoardCard[],
  parentId: string,
  columns: BoardColumn[],
): { done: number; total: number } | null {
  const children = subIssues(cards, parentId);
  if (!children.length) return null;
  const finished = new Set(
    columns
      .filter((column) => column.role === "done" || column.role === "archive")
      .map((column) => column.key),
  );
  return {
    done: children.filter((card) => finished.has(card.columnKey)).length,
    total: children.length,
  };
}

/** Every tag on the board, most-used first, for the filter menu. */
export function tagVocabulary(cards: BoardCard[]): string[] {
  const counts = new Map<string, number>();
  for (const card of cards)
    for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

export const columnOf = (
  columns: BoardColumn[],
  key: string,
): BoardColumn | undefined => columns.find((column) => column.key === key);

export const categoryOf = (
  categories: BoardCategory[],
  key: string | null,
): BoardCategory | undefined =>
  key === null ? undefined : categories.find((entry) => entry.key === key);

/**
 * How many boxes are ticked, or null when nobody has said.
 *
 * NOTE: The board's own `checklistProgress` wins over counting `checklist`.
 * Both are right when both are there, but only the count arrives on a LIST
 * read; counting alone would give null for every card on a board, and no
 * `3/7` beside a row.
 *
 * It still falls back to counting the rows. The count comes from a control
 * plane this app does not deploy in lockstep with, so a service that has not
 * shipped it yet keeps working on the one screen that reads a card whole.
 */
export function checklistProgress(
  card: BoardCard,
): { done: number; total: number } | null {
  if (card.checklistProgress) return card.checklistProgress;
  if (!card.checklist) return null;
  return {
    done: card.checklist.filter((item) => item.checked).length,
    total: card.checklist.length,
  };
}
