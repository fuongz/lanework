import { createFileRoute } from "@tanstack/react-router";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { ReviewList } from "@/components/kanban/review-list";
import { useBoardData } from "./board.$owner.$repo";

export const Route = createFileRoute("/board/$owner/$repo/$view")({
  component: ViewPage,
});

function ViewPage() {
  const { view } = Route.useParams();
  const { filtered } = useBoardData();

  if (view === "list") return <ReviewList cards={filtered} />;
  return <KanbanBoard cards={filtered} />;
}
