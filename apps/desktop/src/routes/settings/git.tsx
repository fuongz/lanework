import { createFileRoute } from "@tanstack/react-router";
import { GitSection } from "#/components/features/settings/git-section";
export const Route = createFileRoute("/settings/git")({
  component: GitSection,
});
