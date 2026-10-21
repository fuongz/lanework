import { createFileRoute } from "@tanstack/react-router";
import { IssuesLayout } from "#/components/features/board/issues-layout";
import { parseIssueSearch } from "#/lib/issue-search";
export const Route = createFileRoute("/_app/w/$slug/issues")({
  // The list's grouping and filters live in the URL, so a link carries them
  // and Back undoes them. On the LAYOUT, not the index: the list stays on
  // screen beside every issue, so every child route reads the same filters.
  validateSearch: parseIssueSearch,
  component: IssuesLayout,
});
