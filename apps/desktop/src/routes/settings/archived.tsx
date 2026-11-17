import { createFileRoute } from "@tanstack/react-router";
import { ProjectArchivedPage } from "#/components/features/settings/project-archived-page";
export const Route = createFileRoute("/settings/archived")({
  component: ProjectArchivedPage,
});
