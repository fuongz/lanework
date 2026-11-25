import { createFileRoute } from "@tanstack/react-router";
import { AutomationsLayout } from "#/components/features/automations/automations-layout";
export const Route = createFileRoute("/_app/w/$slug/automations")({
  component: AutomationsLayout,
});
