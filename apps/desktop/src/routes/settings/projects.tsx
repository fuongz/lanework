import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSection } from "#/components/features/settings/projects-section";
export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSection,
});
