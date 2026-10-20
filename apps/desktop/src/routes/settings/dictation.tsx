import { createFileRoute } from "@tanstack/react-router";
import { DictationSection } from "#/components/features/settings/dictation-section";
export const Route = createFileRoute("/settings/dictation")({
  component: DictationSection,
});
