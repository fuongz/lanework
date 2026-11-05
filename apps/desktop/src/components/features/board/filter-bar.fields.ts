import {
  Alert02Icon,
  Flag02Icon,
  Loading03Icon,
  Tag01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import type { BoardView } from "#/../shared/projects";
import {
  byStatusOrder,
  laneIcon,
  PRIORITY_GROUPS,
  statusKeys,
  tagVocabulary,
} from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";
import {
  DIAGNOSIS_KINDS,
  DIAGNOSIS_LABEL,
  type DiagnosisKind,
} from "./issues-list.diagnostics";

/**
 * The axes a board can be filtered on: the four the URL keeps, and "Needs
 * attention" (FE-116), which is the list's own state.
 */
export type FilterKey =
  | "status"
  | "category"
  | "priority"
  | "tag"
  | "attention";

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
        lane: laneIcon(column),
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

/**
 * The "Needs attention" axis (FE-116/D1), or null while no card needs any.
 *
 * Offers "Any reason" and each kind that flags at least one card: a kind that
 * flags none would filter the list down to nothing.
 *
 * NOTE: The kind in play is offered even once it flags nothing. A filter
 * that cuts the list while its chip is gone is a list nobody can explain.
 */
export function attentionField(
  counts: Record<DiagnosisKind, number>,
  selected?: string,
): FilterField | null {
  const kinds = DIAGNOSIS_KINDS.filter(
    (kind) => counts[kind] > 0 || kind === selected,
  );
  if (!kinds.length && !selected) return null;
  return {
    key: "attention",
    label: "Needs attention",
    icon: Alert02Icon,
    options: [
      { value: "any", label: "Any reason" },
      ...kinds.map((kind) => ({ value: kind, label: DIAGNOSIS_LABEL[kind] })),
    ],
  };
}

/**
 * The options actually in play, in the order the user added them.
 *
 * `attention` is passed apart: it is the list's state, not the URL's.
 */
export function activeFilters(
  fields: FilterField[],
  search: IssueSearch,
  attention?: string,
): { field: FilterField; option: FilterOption }[] {
  return fields.flatMap((field) => {
    const value = field.key === "attention" ? attention : search[field.key];
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
