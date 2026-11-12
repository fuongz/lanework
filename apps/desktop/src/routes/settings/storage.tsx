import { createFileRoute } from "@tanstack/react-router";
import { StorageSection } from "#/components/features/settings/storage-section";
export const Route = createFileRoute("/settings/storage")({
  component: StorageSection,
});
