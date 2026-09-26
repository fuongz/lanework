import { createFileRoute } from "@tanstack/react-router";
import { HistoryEmpty } from "#/components/features/repo/history-empty";
export const Route = createFileRoute("/_app/w/$slug/history/")({
  component: HistoryEmpty,
});
