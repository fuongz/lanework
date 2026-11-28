import { createFileRoute } from "@tanstack/react-router";
import { UsageForecastSection } from "#/components/features/settings/usage-forecast-section";
export const Route = createFileRoute("/settings/usage")({
  component: UsageForecastSection,
});
