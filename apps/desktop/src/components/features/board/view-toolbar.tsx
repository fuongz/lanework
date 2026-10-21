import {
  CloudSavingDone01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SourceHeader } from "#/components/shared/navigation/source-tabs";
import { Button } from "#/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import type { GroupBy } from "#/lib/board-view";
import type { IssueSearch } from "#/lib/issue-search";
import { useBoard } from "#/stores/board";
import { useGitHubIssues } from "#/stores/github-issues";
import { FilterButton, FilterChips } from "./filter-bar";

const when = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "an unknown time"
    : at.toLocaleTimeString();
};

const _GROUP_LABEL: Record<GroupBy, string> = {
  status: "Status",
  category: "Category",
  priority: "Priority",
};

/**
 * How fresh the board is, as the refresh button's tooltip.
 *
 * NOTE: Two states with two different glyphs and two different words, never
 * one string with a separator in it. "Nothing here" and "I could not ask" look
 * identical on screen otherwise, and somebody who trusts an empty board starts
 * typing a card that already exists.
 */
function Freshness({ stale, at }: { stale: boolean; at: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {stale ? (
        <HugeiconsIcon
          icon={CloudSavingDone01Icon}
          className="text-tone-amber size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          className="bg-tone-emerald size-1.5 rounded-full"
        />
      )}
      <span>{stale ? "Saved copy" : "Live"}</span>
      <span className="tabular-nums opacity-70">{when(at)}</span>
    </span>
  );
}

/**
 * The issue list's header: search, filter and refresh (FE-75).
 *
 * It sits at the top of the list's own column, sized for a column a third of
 * the window wide. The window's title bar belongs to the issue beside it.
 *
 * - The search box answers both the board's cards and the GitHub issues.
 * - The filters are the board's own, so they cut the cards only.
 * - Refresh reads both again.
 */
export function ViewToolbar({
  slug,
  search,
  onSearch,
  query,
  onQuery,
}: {
  slug: string;
  search: IssueSearch;
  onSearch: (next: IssueSearch) => void;
  /** The search box's text. Not in the URL: it is a glance, not a view. */
  query: string;
  onQuery: (next: string) => void;
}) {
  const view = useBoard((state) => state.view);
  const loading = useBoard((state) => state.loading);
  const reload = useBoard((state) => state.reload);
  const refreshGitHub = useGitHubIssues((state) => state.refresh);

  return (
    <SourceHeader
      slug={slug}
      value="issues"
      search={{ query, onQuery, label: "Search issues" }}
      actions={
        <>
          <FilterButton search={search} onSearch={onSearch} />

          {/* The freshness lives in the tooltip, and in the button's name for
            anybody who cannot hover. A SAVED copy still marks the button
            itself — the one state that must not wait for a hover. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-7 shrink-0"
                  aria-label={
                    view
                      ? `Refresh board — ${view.stale ? "Saved copy" : "Live"}, ${when(view.fetchedAt)}`
                      : "Refresh board"
                  }
                  disabled={loading}
                  onClick={() => {
                    void reload();
                    void refreshGitHub(slug);
                  }}
                />
              }
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                className="text-muted-foreground size-3.5"
                strokeWidth={1.8}
              />
              {view?.stale && (
                <span
                  aria-hidden="true"
                  className="bg-tone-amber absolute top-1 right-1 size-1.5 rounded-full"
                />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {view ? (
                <Freshness stale={view.stale} at={view.fetchedAt} />
              ) : (
                "Refresh board"
              )}
            </TooltipContent>
          </Tooltip>
        </>
      }
    >
      <FilterChips search={search} onSearch={onSearch} />
    </SourceHeader>
  );
}
