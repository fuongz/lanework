import { createFileRoute } from "@tanstack/react-router";
import { LeadsSection } from "#/components/features/settings/leads-section";
export const Route = createFileRoute("/settings/leads")({
  component: LeadsSection,
});
