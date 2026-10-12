import { createFileRoute } from "@tanstack/react-router";
import { InstructionDetail } from "#/components/features/instructions/instruction-detail";
export const Route = createFileRoute("/settings/instructions/$id")({
  component: InstructionDetail,
});
