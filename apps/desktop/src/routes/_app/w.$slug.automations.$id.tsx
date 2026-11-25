import { createFileRoute } from "@tanstack/react-router";
import { AutomationDetail } from "#/components/features/automations/automation-detail";
export const Route = createFileRoute("/_app/w/$slug/automations/$id")({
  component: AutomationDetail,
});
