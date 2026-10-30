import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/settings/workspaces")({
  // Kept as a redirect, not deleted (FE-107): the section was renamed to
  // Projects, and a link or a bookmark to the old address still lands there.
  beforeLoad: () => {
    throw redirect({ to: "/settings/projects", replace: true });
  },
});
