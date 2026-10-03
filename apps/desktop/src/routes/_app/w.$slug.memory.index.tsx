import { createFileRoute } from "@tanstack/react-router";
import { MemoryPick } from "#/components/features/memory/memory-pick";
export const Route = createFileRoute("/_app/w/$slug/memory/")({
  component: MemoryPick,
});
