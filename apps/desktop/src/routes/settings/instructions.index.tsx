import { createFileRoute } from "@tanstack/react-router";
import { InstructionsPick } from "#/components/features/instructions/instructions-pick";
export const Route = createFileRoute("/settings/instructions/")({
  component: InstructionsPick,
});
