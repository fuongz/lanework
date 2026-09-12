import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceLayout } from "#/components/features/workspaces/workspace-layout";
export const Route = createFileRoute("/_app/w/$slug")({
  component: WorkspaceLayout,
});
