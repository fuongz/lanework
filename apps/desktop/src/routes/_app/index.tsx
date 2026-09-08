import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceHome } from "#/components/features/workspaces/workspace-home";
export const Route = createFileRoute("/_app/")({ component: WorkspaceHome });
