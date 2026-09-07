import { createFileRoute } from "@tanstack/react-router";
import { AccountSection } from "#/components/features/settings/account-section";
export const Route = createFileRoute("/settings/account")({
  component: AccountSection,
});
