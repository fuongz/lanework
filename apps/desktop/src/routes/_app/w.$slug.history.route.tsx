import { createFileRoute } from "@tanstack/react-router";
import { HistoryLayout } from "#/components/features/repo/history-layout";
export const Route = createFileRoute("/_app/w/$slug/history")({
  component: HistoryLayout,
});
