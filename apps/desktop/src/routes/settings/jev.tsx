import { createFileRoute } from "@tanstack/react-router";
import { JevSection } from "#/components/features/settings/jev-section";
export const Route = createFileRoute("/settings/jev")({
  component: JevSection,
});
