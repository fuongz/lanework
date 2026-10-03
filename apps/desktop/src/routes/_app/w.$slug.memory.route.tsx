import { createFileRoute } from "@tanstack/react-router";
import { MemoryLayout } from "#/components/features/memory/memory-layout";
export const Route = createFileRoute("/_app/w/$slug/memory")({
  component: MemoryLayout,
});
