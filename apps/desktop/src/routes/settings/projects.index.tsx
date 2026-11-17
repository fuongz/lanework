import { createFileRoute } from "@tanstack/react-router";
import { ProjectsList } from "#/components/features/settings/projects-list";
export const Route = createFileRoute("/settings/projects/")({
  component: ProjectsList,
});
