import { createFileRoute } from "@tanstack/react-router";
import { PullsLayout } from "#/components/features/pulls/pulls-layout";
import { parsePullSearch } from "#/lib/pull-search";
export const Route = createFileRoute("/_app/w/$slug/issues_/pulls")({
  // The tab lives in the URL so a link carries it and Back undoes it, as the
  // issues view does for its grouping and filters.
  validateSearch: parsePullSearch,
  component: PullsLayout,
});
