import { createFileRoute } from "@tanstack/react-router";
import { NotificationsSection } from "#/components/features/settings/notifications-section";
export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsSection,
});
