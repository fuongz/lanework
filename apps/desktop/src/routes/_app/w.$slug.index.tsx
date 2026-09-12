import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/w/$slug/")({
  // A project has no page of its own: opening one means opening its issues.
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/w/$slug/issues", params, replace: true });
  },
});
