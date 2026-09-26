import { createFileRoute } from "@tanstack/react-router";
import { AgentView } from "#/components/features/agents/agent-view";
export const Route = createFileRoute("/_app/w/$slug/agents/$terminalId")({
  component: AgentView,
});
