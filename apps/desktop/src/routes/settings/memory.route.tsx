import { createFileRoute } from "@tanstack/react-router";
import { MemoryLayout } from "#/components/features/memory/memory-layout";
import { projectSearch } from "#/lib/project-search";
export const Route = createFileRoute("/settings/memory")({
  validateSearch: projectSearch,
  component: MemoryLayout,
});
