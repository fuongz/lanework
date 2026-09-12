import { createFileRoute } from "@tanstack/react-router";
import { BoardLanes } from "#/components/features/board/board-lanes";
import { parseIssueSearch } from "#/lib/issue-search";
export const Route = createFileRoute("/_app/w/$slug/board")({
  validateSearch: parseIssueSearch,
  component: BoardLanes,
});
