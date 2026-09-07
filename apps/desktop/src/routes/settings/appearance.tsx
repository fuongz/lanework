import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSection } from "#/components/features/settings/appearance-section";
export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSection,
});
