import { createFileRoute } from "@tanstack/react-router";
import { InstructionsLayout } from "#/components/features/instructions/instructions-layout";
import { projectSearch } from "#/lib/project-search";
export const Route = createFileRoute("/settings/instructions")({
  validateSearch: projectSearch,
  component: InstructionsLayout,
});
