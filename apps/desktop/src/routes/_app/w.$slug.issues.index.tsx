import { createFileRoute } from "@tanstack/react-router";
import { IssuesList } from "#/components/features/board/issues-list";
import { parseIssueSearch } from "#/lib/issue-search";
export const Route = createFileRoute("/_app/w/$slug/issues/")({
  // ⚠️ The view's grouping and filters live in the URL, so a link carries them
  // and Back undoes them. Unknown values fall back rather than throw: a link
  // from an older build must open the board, not a router error page.
  validateSearch: parseIssueSearch,
  component: IssuesList,
});
