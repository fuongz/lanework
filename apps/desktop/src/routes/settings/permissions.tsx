import { createFileRoute } from "@tanstack/react-router";
import { PermissionsSection } from "#/components/features/settings/permissions-section";
export const Route = createFileRoute("/settings/permissions")({
  component: PermissionsSection,
});
