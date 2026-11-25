import { createFileRoute } from "@tanstack/react-router";
import { AutomationsEmpty } from "#/components/features/automations/automations-empty";
export const Route = createFileRoute("/_app/w/$slug/automations/")({
  component: AutomationsEmpty,
});
