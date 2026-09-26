import { createFileRoute } from "@tanstack/react-router";
import { ChangesLayout } from "#/components/features/repo/changes-layout";
export const Route = createFileRoute("/_app/w/$slug/changes")({
  component: ChangesLayout,
});
