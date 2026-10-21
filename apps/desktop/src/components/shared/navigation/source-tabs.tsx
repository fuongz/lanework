import {
  GitPullRequestIcon,
  ListViewIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SegmentedControl } from "#/components/shared/common/segmented-control";
import { Input } from "#/components/ui/input";

type Source = "issues" | "pulls";

const SOURCES = [
  { value: "issues", label: "Issues", icon: ListViewIcon },
  { value: "pulls", label: "Pull requests", icon: GitPullRequestIcon },
] as const;

/**
 * Issues and Pull requests as two tabs over one list column (FE-75). Pull
 * requests used to be their own row under Repository; they live here now.
 *
 * NOTE: Each tab is its own screen with its own route, and the bar is drawn
 * at the top of both lists. Switching keeps nothing of the other's filters:
 * a filter on cards means nothing to a pull request.
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
 * the list beside it (FE-75).
 *
 * NOTE: One component for both, not two copies that look alike. Switching tab
 * swaps the screen under this header, and any pixel the two disagreed on —
 * a gap, the search box's height — made the whole header jump.
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
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <Input
              value={search.query}
              onChange={(event) => search.onQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears the box first, and leaves it on the next press.
                if (event.key === "Escape" && search.query) {
                  event.preventDefault();
                  search.onQuery("");
                }
              }}
              placeholder={search.label}
              aria-label={search.label}
              className="pl-7"
            />
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
