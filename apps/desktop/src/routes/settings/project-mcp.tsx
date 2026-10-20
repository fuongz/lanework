import { createFileRoute } from "@tanstack/react-router";
import { McpSection } from "#/components/features/settings/mcp-section";
export const Route = createFileRoute("/settings/project-mcp")({
  component: () => <McpSection scope="project" />,
});
