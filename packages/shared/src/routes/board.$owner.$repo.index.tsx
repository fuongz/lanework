import { createFileRoute, redirect } from "@tanstack/react-router";

// Bare `/board/$owner/$repo` has no view — send it to the default view, keeping
// the current search (branch / mine / tag) intact.
export const Route = createFileRoute("/board/$owner/$repo/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/board/$owner/$repo/$view",
      params: { ...params, view: "board" },
      search,
      replace: true,
    });
  },
});
