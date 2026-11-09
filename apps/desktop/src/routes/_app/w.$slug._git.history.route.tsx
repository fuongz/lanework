import { createFileRoute } from "@tanstack/react-router";
// The History tab of the Git view; `GitLayout` draws it (FE-130).
export const Route = createFileRoute("/_app/w/$slug/_git/history")({});
