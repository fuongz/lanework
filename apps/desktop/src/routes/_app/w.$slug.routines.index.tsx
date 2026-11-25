import { createFileRoute } from "@tanstack/react-router";
import { RoutinesEmpty } from "#/components/features/routines/routines-empty";
export const Route = createFileRoute("/_app/w/$slug/routines/")({
  component: RoutinesEmpty,
});
