import { createFileRoute } from "@tanstack/react-router";
import { NewIssue } from "#/components/features/board/new-issue";
// ⚠️ A static segment beside `$taskId`, and the router matches it first — a card
// can never be called `new`, because the board mints its keys as `FE-06`.
export const Route = createFileRoute("/_app/w/$slug/issues/new")({
  component: NewIssue,
});
