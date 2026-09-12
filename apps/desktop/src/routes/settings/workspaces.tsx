import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesSection } from "#/components/features/settings/workspaces-section";
export const Route = createFileRoute("/settings/workspaces")({
  component: WorkspacesSection,
});
