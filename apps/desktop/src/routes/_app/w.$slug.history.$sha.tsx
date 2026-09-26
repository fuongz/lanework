import { createFileRoute } from "@tanstack/react-router";
import { CommitDetail } from "#/components/features/repo/commit-detail";
export const Route = createFileRoute("/_app/w/$slug/history/$sha")({
  component: CommitDetail,
});
