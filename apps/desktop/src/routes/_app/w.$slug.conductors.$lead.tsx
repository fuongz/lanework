import { createFileRoute } from "@tanstack/react-router";
import { ConductorView } from "#/components/features/conductors/conductor-view";

/** A conductor's own conversation in this project (FE-95). */
export const Route = createFileRoute("/_app/w/$slug/conductors/$lead")({
  component: ConductorView,
});
