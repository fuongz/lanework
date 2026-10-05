import { createFileRoute } from "@tanstack/react-router";
import { ShellTaskView } from "#/components/features/agents/shell-task-view";

// A Claude conversation's background shell (FE-42/D3). Claude only: Codex
// lists no background tasks, so no `agent` search the way `sub` takes one.
export const Route = createFileRoute(
  "/_app/w/$slug/agents/task/$conversation/$task",
)({
  component: ShellTaskView,
});
