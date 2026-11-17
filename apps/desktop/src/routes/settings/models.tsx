import { createFileRoute, redirect } from "@tanstack/react-router";

/** Models moved into each CLI's page under Harness (FE-146). */
export const Route = createFileRoute("/settings/models")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/harness" });
  },
});
