import { createFileRoute } from "@tanstack/react-router";
import { CostView } from "@/components/kanban/cost-view";
import { useBoardData } from "./board.$owner.$repo";

// Cost lives under the board layout (so it shares the loaded board + sidebar),
// but the layout hides its review header/tabs for this child — see BoardLayout.
export const Route = createFileRoute("/board/$owner/$repo/cost")({
  component: CostPage,
});

function CostPage() {
  const { board } = useBoardData();
  return <CostView repo={board.repo} />;
}
