import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "#/components/features/settings/skills-page";
import { fileSearch } from "#/lib/agent-config-search";
export const Route = createFileRoute("/settings/skills")({
  validateSearch: fileSearch,
  component: SkillsPage,
});
