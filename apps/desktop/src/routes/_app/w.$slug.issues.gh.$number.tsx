import { createFileRoute } from "@tanstack/react-router";
import { GitHubIssuePage } from "#/components/features/board/github-issue-page";
// Under `gh/` so a GitHub issue's number can never be read as a card's task id.
export const Route = createFileRoute("/_app/w/$slug/issues/gh/$number")({
  component: GitHubIssuePage,
});
