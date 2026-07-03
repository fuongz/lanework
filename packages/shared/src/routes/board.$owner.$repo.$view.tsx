import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { ReviewList } from "@/components/kanban/review-list";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useBoardData } from "./board.$owner.$repo";

export const Route = createFileRoute("/board/$owner/$repo/$view")({
  component: ViewPage,
});

function ViewPage() {
  const { view } = Route.useParams();
  const { filtered, board } = useBoardData();

  // Live "running" set from the local agent dispatcher (no-op / empty when hosted).
  const { status } = useAgentStatus(__LANEWORK_LOCAL__);
  const runningPaths = useMemo(() => {
    const set = new Set<string>();
    if (status) {
      for (const [path, a] of Object.entries(status.agents)) {
        if (a.state === "running") set.add(path);
      }
    }
    return set;
  }, [status]);

  if (view === "list")
    return <ReviewList cards={filtered} runningPaths={runningPaths} statusLabels={board.statusLabels} />;
  return (
    <KanbanBoard
      cards={filtered}
      owner={board.owner}
      repo={board.repo}
      runningPaths={runningPaths}
      statusLabels={board.statusLabels}
    />
  );
}
