import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/w/$slug/pulls/$number")({
  // Kept as a redirect, not deleted (FE-75): a pull request's old address
  // lands on the same pull request at its new one.
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/w/$slug/issues/pulls/$number",
      params,
      // The list's tab and state, from the old parent route's search.
      search,
      replace: true,
    });
  },
});
