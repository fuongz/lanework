import { createFileRoute } from "@tanstack/react-router";
import { InstructionDetail } from "#/components/features/instructions/instruction-detail";
export const Route = createFileRoute("/_app/w/$slug/instructions/$id")({
  component: InstructionDetail,
});
