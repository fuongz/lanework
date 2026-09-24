import { createFileRoute, redirect } from "@tanstack/react-router";
import { parseIssueSearch } from "#/lib/issue-search";
export const Route = createFileRoute("/_app/w/$slug/board")({
  // ⚠️ Kept as a redirect, not deleted (FE-13/D4). The board is a VIEW of the
  // issues now, but a link, a ⌘K entry or saved state from an older build can
  // still name this path, and it should land on the lanes — filters intact —
  // rather than on a "not found".
  validateSearch: parseIssueSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/w/$slug/issues",
      params,
      search: { ...search, view: "board" },
      replace: true,
    });
  },
});
