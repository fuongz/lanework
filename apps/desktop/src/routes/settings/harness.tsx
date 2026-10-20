import { createFileRoute } from "@tanstack/react-router";
import { HarnessSection } from "#/components/features/settings/harness-section";
export const Route = createFileRoute("/settings/harness")({
  component: HarnessSection,
});
