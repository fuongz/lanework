import { createFileRoute } from "@tanstack/react-router";
import { InstructionsLayout } from "#/components/features/instructions/instructions-layout";
export const Route = createFileRoute("/_app/w/$slug/instructions")({
  component: InstructionsLayout,
});
