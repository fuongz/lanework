import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useBoard } from "#/stores/board";
import { usePresencePoll } from "#/stores/board-presence";

export const Route = createFileRoute("/_app/w/$slug/issues")({
  component: IssuesLayout,
});

/**
 * Every view of the issues — list, lanes, one issue — and, while any of them
 * is open, who is working on the board from other machines (BE-16/D2a).
 */
function IssuesLayout() {
  const { slug } = Route.useParams();
  const workspaceId = useBoard(
    (state) =>
      state.workspaces.find((entry) => entry.slug === slug)?.id ?? null,
  );
  usePresencePoll(workspaceId);
  return <Outlet />;
}
