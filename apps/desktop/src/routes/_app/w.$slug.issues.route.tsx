import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useBoard } from "#/stores/board";
import { usePresencePoll } from "#/stores/board-presence";
import { useCloudFeatures } from "#/stores/session";

export const Route = createFileRoute("/_app/w/$slug/issues")({
  component: IssuesLayout,
});

/**
 * Every view of the issues — list, lanes, one issue — and, while any of them
 * is open, who is working on the board from other machines (BE-16/D2a).
 */
function IssuesLayout() {
  const { slug } = Route.useParams();
  const workspace = useBoard(
    (state) => state.workspaces.find((entry) => entry.slug === slug) ?? null,
  );
  // FE-52/D10: nobody else is on a local board, so there is nothing to poll.
  const { presence } = useCloudFeatures(workspace);
  usePresencePoll(presence ? (workspace?.id ?? null) : null);
  return <Outlet />;
}
