import {
  Flag02Icon,
  Loading03Icon,
  Tag01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import type { BoardView } from "#/../shared/projects";
import {
  byStatusOrder,
  PRIORITY_GROUPS,
  statusKeys,
  tagVocabulary,
} from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";

/** The four axes a board can be filtered on. */
export type FilterKey = "status" | "category" | "priority" | "tag";

export interface FilterOption {
  value: string;
  label: string;
  /** A board tone, when the option has one: the dot's or the lane glyph's. */
  tone?: string;
  /** A lane icon key, for the status axis only. */
  lane?: string;
}

export interface FilterField {
  key: FilterKey;
  label: string;
  icon: typeof Tag01Icon;
  options: FilterOption[];
  /** Several values at once (status). */
  multiple?: boolean;
}

/**
 * The axes a board can be filtered on, and what each one offers.
 *
 * Built from the board, not from a hard-coded list. Lanes, categories and the
 * tag vocabulary all belong to the service, so a filter menu written out here
 * would offer states this board does not have and miss the ones it does.
 * Priority is the exception: it is a fixed column on the card itself.
 */
export function filterFields(
  view: Pick<BoardView, "columns" | "categories" | "cards"> | null,
): FilterField[] {
  if (!view) return [];
  const fields: FilterField[] = [
    {
      key: "status",
      label: "Status",
      icon: Loading03Icon,
      multiple: true,
      // In Progress, To-Do, Backlog, then what is finished.
      options: byStatusOrder(view.columns).map((column) => ({
        value: column.key,
        label: column.name,
        tone: column.tone,
        lane: column.icon,
      })),
    },
    {
      key: "priority",
      label: "Priority",
      icon: Flag02Icon,
      options: PRIORITY_GROUPS.map((group) => ({
        value: group.key,
        label: group.name,
        tone: group.tone,
      })),
    },
  ];
  if (view.categories.length)
    fields.splice(1, 0, {
      key: "category",
      label: "Category",
      icon: UserAccountIcon,
      options: view.categories.map((category) => ({
        value: category.key,
        label: category.name,
        tone: category.tone,
      })),
    });
  const tags = tagVocabulary(view.cards);
  if (tags.length)
    fields.push({
      key: "tag",
      label: "Tag",
      icon: Tag01Icon,
      options: tags.map((tag) => ({ value: tag, label: tag })),
    });
  return fields;
}

/** The options actually in play, in the order the user added them. */
export function activeFilters(
  fields: FilterField[],
  search: IssueSearch,
): { field: FilterField; option: FilterOption }[] {
  return fields.flatMap((field) => {
    const value = search[field.key];
    if (!value) return [];
    // The status set is one chip naming every lane in it. No `status` in the
    // URL is the default set, which is no filter to show.
    if (field.multiple) {
      const lanes = new Set(
        statusKeys(
          field.options.map((option) => ({ key: option.value, role: null })),
          value,
        ),
      );
      const picked = field.options.filter((option) => lanes.has(option.value));
      return [
        {
          field,
          option: {
            value,
            label: picked.length
              ? picked.map((option) => option.label).join(", ")
              : "None",
            ...(picked.length === 1
              ? { tone: picked[0].tone, lane: picked[0].lane }
              : {}),
          },
        },
      ];
    }
    const option = field.options.find((entry) => entry.value === value) ?? {
      value,
      // NOTE: A value the board no longer offers still gets a chip. A filter
      // that cuts the list while showing nothing is how somebody concludes
      // their cards are gone.
      label: value,
    };
    return [{ field, option }];
  });
}
