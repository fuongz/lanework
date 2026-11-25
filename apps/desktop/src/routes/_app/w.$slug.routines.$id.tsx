import { createFileRoute } from "@tanstack/react-router";
import { RoutineDetail } from "#/components/features/routines/routine-detail";
export const Route = createFileRoute("/_app/w/$slug/routines/$id")({
  component: RoutineDetail,
});
