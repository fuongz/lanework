import { createFileRoute, redirect } from "@tanstack/react-router";
import { parsePullSearch } from "#/lib/pull-search";
export const Route = createFileRoute("/_app/w/$slug/pulls")({
  // Kept as a redirect, not deleted (FE-75). Pull requests are a tab of
  // Issues, at /issues/pulls, but a notification, a link or saved state from
  // an older build can still name this path.
  validateSearch: parsePullSearch,
  beforeLoad: ({ params, search, location }) => {
    // One pull request's old address is the child route's to move, so it
    // lands on that pull request rather than on the list.
    if (!/\/pulls\/?$/.test(location.pathname)) return;
    throw redirect({
      to: "/w/$slug/issues/pulls",
      params,
      search,
      replace: true,
    });
  },
});
