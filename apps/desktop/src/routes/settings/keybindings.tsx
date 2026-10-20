import { createFileRoute } from "@tanstack/react-router";
import { KeybindingsSection } from "#/components/features/settings/keybindings-section";
export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsSection,
});
