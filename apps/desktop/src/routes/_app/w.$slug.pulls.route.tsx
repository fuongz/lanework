import { createFileRoute } from "@tanstack/react-router";
import { PullsLayout } from "#/components/features/pulls/pulls-layout";
import { parsePullSearch } from "#/lib/pull-search";
export const Route = createFileRoute("/_app/w/$slug/pulls")({
  // ⚠️ The tab lives in the URL so a link carries it and Back undoes it, the
  // same choice the issues view makes for its grouping and filters.
  validateSearch: parsePullSearch,
  component: PullsLayout,
});
