import { createFileRoute } from "@tanstack/react-router";
import { ProjectSkillsPage } from "#/components/features/settings/project-skills-page";
export const Route = createFileRoute("/settings/project-skills")({
  component: ProjectSkillsPage,
});
