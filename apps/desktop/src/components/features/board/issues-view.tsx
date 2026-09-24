import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { ViewToolbar } from "#/components/shared/board/view-toolbar";
import { useIssueView } from "#/stores/issue-view";
import { BoardLanes } from "./board-lanes";
import { IssuesList } from "./issues-list";

/**
 * A project's issues, as rows or as lanes — one page, two ways to draw it.
 *
 * ⚠️ The board is a VIEW of this page, not a page of its own (FE-13/D4). Both
 * draw the same cards under the same filters, and a separate route made the
 * filters fall off every time you switched between them. `?view=board` picks
 * the lanes; everything else in the URL is shared.
 *
 * ⚠️ The toolbar lives HERE, above both, and only the body swaps. When each
 * view drew its own, switching remounted the bar: the List/Board pill had no
 * element to slide from, a half-typed "Add a card…" was thrown away, and the
 * filter chips blinked. One bar that stays put is the thing being switched
 * FROM, which is what makes the switch read as a change of view.
 */
export function IssuesView() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues/" });
  const search = useSearch({ from: "/_app/w/$slug/issues/" });
  const navigate = useNavigate();
  const remember = useIssueView((state) => state.remember);
  const view = search.view ?? "list";

  // What the URL says is what the rail's "Issues" row reopens next time.
  useEffect(() => remember(slug, view), [remember, slug, view]);

  return (
    <>
      <ViewToolbar
        title="All issues"
        search={search}
        // The lanes ARE the status, so "group by" only exists on the list.
        grouping={view === "list"}
        onSearch={(next) =>
          void navigate({
            to: "/w/$slug/issues",
            params: { slug },
            search: next,
            replace: true,
          })
        }
      />
      {view === "board" ? <BoardLanes /> : <IssuesList />}
    </>
  );
}
