import { createFileRoute } from "@tanstack/react-router";
import { AgentConfigPage } from "#/components/shared/settings/agent-config-page";
import { fileSearch } from "#/lib/agent-config-search";
export const Route = createFileRoute("/settings/skills")({
  validateSearch: fileSearch,
  component: () => <AgentConfigPage kind="skill" />,
});
