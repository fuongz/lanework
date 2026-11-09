import { createFileRoute } from "@tanstack/react-router";
// One commit in the History tab, in the URL so Back returns to the previous
// one and a link carries it; `GitLayout` draws it (FE-130).
export const Route = createFileRoute("/_app/w/$slug/_git/history/$sha")({});
