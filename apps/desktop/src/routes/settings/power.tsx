import { createFileRoute } from "@tanstack/react-router";
import { PowerSection } from "#/components/features/settings/power-section";
export const Route = createFileRoute("/settings/power")({
  component: PowerSection,
});
