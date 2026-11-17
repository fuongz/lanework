import { GitPullRequestIcon, ListViewIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ListSearch } from "#/components/shared/common/list-search";
import { SegmentedControl } from "#/components/shared/common/segmented-control";

type Source = "issues" | "pulls";

const SOURCES = [
  { value: "issues", label: "Issues", icon: ListViewIcon },
  { value: "pulls", label: "Pull requests", icon: GitPullRequestIcon },
] as const;

/**
 * Issues and Pull requests as two tabs over one list column.
 *
 * Each tab is its own screen with its own route, and the bar is drawn at the
 * top of both lists. Switching keeps nothing of the other's filters: a filter
 * on cards means nothing to a pull request.
 */
function SourceTabs({ slug, value }: { slug: string; value: Source }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      label="Show"
      semantics="current"
      value={value}
      options={SOURCES}
      // One id for both screens' copies, so the pill slides across the switch
      // rather than appearing on the other tab.
      layoutId="source-tabs-pill"
      onChange={(next) =>
        void navigate(
          next === "issues"
            ? { to: "/w/$slug/issues", params: { slug } }
            : { to: "/w/$slug/issues/pulls", params: { slug } },
        )
      }
    />
  );
}

/**
 * The top of either list: the tabs, then the search box and whatever acts on
 * the list beside it.
 *
 * NOTE: One component for both, not two copies that look alike. Switching tab
 * swaps the screen under this header, and any pixel the two disagree on (a
 * gap, the search box's height) makes the whole header jump.
 */
export function SourceHeader({
  slug,
  value,
  search,
  actions,
  children,
}: {
  slug: string;
  value: Source;
  /** The search box, or nothing while there is no list to search. */
  search?: {
    query: string;
    onQuery: (next: string) => void;
    label: string;
  };
  /** Beside the search box: the filter and Refresh. */
  actions?: ReactNode;
  /** Under the search row, e.g. the filters in play. */
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2 pb-2">
      <SourceTabs slug={slug} value={value} />
      {search && (
        <ListSearch
          query={search.query}
          onQuery={search.onQuery}
          label={search.label}
          actions={actions}
        />
      )}
      {children}
    </div>
  );
}
