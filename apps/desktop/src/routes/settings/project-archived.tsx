import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/settings/project-archived")({
  // An old address (FE-145): Archived moved under Agents, with the project
  // picked on the page.
  beforeLoad: () => {
    throw redirect({ to: "/settings/archived", replace: true });
  },
});
