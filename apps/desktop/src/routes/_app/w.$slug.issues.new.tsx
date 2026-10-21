import { createFileRoute } from "@tanstack/react-router";
import { NewIssue } from "#/components/features/board/new-issue";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 65_536 ? value : undefined;

// NOTE: A static segment beside `$taskId`, and the router matches it first — a
// card can never be called `new`, because the board mints its keys as `FE-06`.
export const Route = createFileRoute("/_app/w/$slug/issues/new")({
  // A prefill, for "Create card from issue" on a GitHub issue (FE-75). Both
  // optional, and anything that is not a string is dropped rather than thrown.
  validateSearch: (
    raw: Record<string, unknown>,
  ): { title?: string; body?: string } => ({
    title: text(raw.title),
    body: text(raw.body),
  }),
  component: NewIssue,
});
