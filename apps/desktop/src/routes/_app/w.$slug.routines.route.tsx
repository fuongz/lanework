import { createFileRoute } from "@tanstack/react-router";
import { RoutinesLayout } from "#/components/features/routines/routines-layout";
export const Route = createFileRoute("/_app/w/$slug/routines")({
  component: RoutinesLayout,
});
