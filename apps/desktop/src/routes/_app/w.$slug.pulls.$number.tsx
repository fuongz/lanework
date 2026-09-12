import { createFileRoute } from "@tanstack/react-router";
import { PullDetail } from "#/components/features/pulls/pull-detail";
export const Route = createFileRoute("/_app/w/$slug/pulls/$number")({
  component: PullDetail,
});
