import { createFileRoute } from "@tanstack/react-router";
import { ProjectLayout } from "#/components/features/projects/project-layout";
export const Route = createFileRoute("/_app/w/$slug")({
  component: ProjectLayout,
});
