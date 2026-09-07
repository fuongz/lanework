import { createFileRoute } from "@tanstack/react-router";
import { AboutSection } from "#/components/features/settings/about-section";
export const Route = createFileRoute("/settings/about")({
  component: AboutSection,
});
