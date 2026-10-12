import { createFileRoute } from "@tanstack/react-router";
import { MemoryDetail } from "#/components/features/memory/memory-detail";
export const Route = createFileRoute("/settings/memory/$file")({
  component: MemoryDetail,
});
