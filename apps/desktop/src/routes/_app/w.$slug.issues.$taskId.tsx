import { createFileRoute } from "@tanstack/react-router";
import { IssueDetail } from "#/components/features/board/issue-detail";
export const Route = createFileRoute("/_app/w/$slug/issues/$taskId")({
  component: IssueDetail,
});
