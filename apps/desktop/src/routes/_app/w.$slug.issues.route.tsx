import { createFileRoute, Outlet } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/w/$slug/issues")({
  component: Outlet,
});
