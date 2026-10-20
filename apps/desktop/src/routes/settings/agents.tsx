import { createFileRoute, redirect } from "@tanstack/react-router";
// What this page held — the hooks, the Lanework MCP entry, the versions — is
// in Settings › Harness now, beside each CLI it is about.
export const Route = createFileRoute("/settings/agents")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/harness" });
  },
});
