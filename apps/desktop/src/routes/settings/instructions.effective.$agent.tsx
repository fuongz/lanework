import { createFileRoute } from "@tanstack/react-router";
import { InstructionsEffective } from "#/components/features/instructions/instructions-effective";
export const Route = createFileRoute("/settings/instructions/effective/$agent")(
  {
    component: InstructionsEffective,
  },
);
