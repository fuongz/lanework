import { createFileRoute } from "@tanstack/react-router";
import { PullsEmpty } from "#/components/features/pulls/pulls-empty";
export const Route = createFileRoute("/_app/w/$slug/issues_/pulls/")({
  component: PullsEmpty,
});
