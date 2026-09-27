import { createFileRoute } from "@tanstack/react-router";
import { AgentsSection } from "#/components/features/settings/agents-section";
export const Route = createFileRoute("/settings/agents")({
  component: AgentsSection,
});
