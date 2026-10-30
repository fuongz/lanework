import { createFileRoute } from "@tanstack/react-router";
import { ModelsSection } from "#/components/features/settings/models-section";
export const Route = createFileRoute("/settings/models")({
  component: ModelsSection,
});
