import { createFileRoute, redirect } from "@tanstack/react-router";
// An old address. The hooks, the Lanework MCP entry and the versions live in
// Settings › Harness, beside each CLI they are about.
export const Route = createFileRoute("/settings/agents")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/harness" });
  },
});
