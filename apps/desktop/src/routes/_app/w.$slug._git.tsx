import { createFileRoute } from "@tanstack/react-router";
import { GitLayout } from "#/components/features/repo/git-layout";
export const Route = createFileRoute("/_app/w/$slug/_git")({
  // Changes and History are two tabs of one view (FE-130), under this
  // pathless layout: their addresses are still /changes and /history/$sha.
  // The layout draws both tabs itself, so the routes below only name them.
  component: GitLayout,
});
