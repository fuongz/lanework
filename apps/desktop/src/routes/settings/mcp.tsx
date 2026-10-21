import { createFileRoute } from "@tanstack/react-router";
import { McpSection } from "#/components/shared/settings/mcp-section";
export const Route = createFileRoute("/settings/mcp")({
  component: () => <McpSection scope="global" />,
});
