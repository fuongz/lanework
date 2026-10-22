import { createFileRoute } from "@tanstack/react-router";
import { AgentConfigPage } from "#/components/features/settings/agent-config-page";
import { fileSearch } from "#/lib/agent-config-search";
export const Route = createFileRoute("/settings/config")({
  validateSearch: fileSearch,
  component: () => <AgentConfigPage kind="config" />,
});
