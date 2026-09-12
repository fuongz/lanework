import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceLanding } from "#/components/features/workspaces/workspace-landing";
export const Route = createFileRoute("/_app/")({ component: WorkspaceLanding });
