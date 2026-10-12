import { createFileRoute } from "@tanstack/react-router";
import { MemoryPick } from "#/components/features/memory/memory-pick";
export const Route = createFileRoute("/settings/memory/")({
  component: MemoryPick,
});
