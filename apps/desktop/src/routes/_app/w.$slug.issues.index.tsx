import { createFileRoute } from "@tanstack/react-router";
import { IssuesEmpty } from "#/components/features/board/issues-empty";
export const Route = createFileRoute("/_app/w/$slug/issues/")({
  component: IssuesEmpty,
});
