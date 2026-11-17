import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSettingsProjectPick } from "#/stores/settings-project";
export const Route = createFileRoute("/settings/project-mcp")({
  // An old address (FE-145): a project's servers are Settings › MCP with
  // that project in the scope row, so leave "All projects" on the way.
  beforeLoad: () => {
    useSettingsProjectPick.getState().setAll(false);
    throw redirect({ to: "/settings/mcp", replace: true });
  },
});
