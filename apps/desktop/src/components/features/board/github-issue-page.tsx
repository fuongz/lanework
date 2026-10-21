import { Link, useParams, useSearch } from "@tanstack/react-router";
import { GitHubIssueDetail } from "#/components/features/github-issues/github-issue-detail";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { parseIssueSearch } from "#/lib/issue-search";
import { useBoard } from "#/stores/board";

/**
 * A GitHub issue in the detail pane, under the same breadcrumb a card has.
 *
 * NOTE: Keyed on the issue. The route stays mounted while j/k moves between
 * issues, and without the key the next issue would open scrolled to where
 * the last one was read.
 */
export function GitHubIssuePage() {
  const { slug, number } = useParams({
    from: "/_app/w/$slug/issues/gh/$number",
  });
  // Just the list's filters: the URL can carry keys of other pages too.
  const filters = parseIssueSearch(useSearch({ from: "/_app/w/$slug/issues" }));
  const active = useBoard((state) => state.active);
  return (
    <>
      <WindowTitlebar className="gap-1">
        <Link
          to="/w/$slug/issues"
          params={{ slug }}
          search={filters}
          className="hover:bg-foreground/[0.05] -ml-2 flex h-7 min-w-0 items-center rounded-md px-2 transition-colors"
        >
          <span className={WINDOW_TITLE}>{active?.name ?? "Issues"}</span>
        </Link>
        <span className="text-muted-foreground shrink-0 text-[13px]">›</span>
        <span className="text-muted-foreground shrink-0 px-1 font-mono text-xs">
          #{number}
        </span>
      </WindowTitlebar>
      <GitHubIssueDetail
        key={`${slug}#${number}`}
        slug={slug}
        number={Number(number)}
      />
    </>
  );
}
