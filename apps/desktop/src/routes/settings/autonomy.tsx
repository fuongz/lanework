import { createFileRoute } from "@tanstack/react-router";
import { AutonomySection } from "#/components/features/settings/autonomy-section";
export const Route = createFileRoute("/settings/autonomy")({
  component: AutonomySection,
});
