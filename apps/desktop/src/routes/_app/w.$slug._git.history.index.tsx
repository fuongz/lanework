import { createFileRoute } from "@tanstack/react-router";
// History with no commit open; `GitLayout` draws it (FE-130).
export const Route = createFileRoute("/_app/w/$slug/_git/history/")({});
