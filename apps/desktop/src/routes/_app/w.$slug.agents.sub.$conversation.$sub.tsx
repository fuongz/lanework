import { createFileRoute } from "@tanstack/react-router";
import { isWorkflowRunId, type TerminalAgent } from "#/../shared/terminal";
import { SubagentView } from "#/components/features/agents/subagent-view";
export const Route = createFileRoute(
  "/_app/w/$slug/agents/sub/$conversation/$sub",
)({
  // NOTE: Which CLI's conversation it is: the ids alone do not say. Anything
  // but Codex is Claude, so a link from an older build still opens. `run`
  // names the workflow run a Claude agent is one of (FE-01); a malformed one
  // is dropped, never sent to main.
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent: TerminalAgent; run?: string } => {
    const agent = search.agent === "codex" ? "codex" : "claude";
    return agent === "claude" && isWorkflowRunId(search.run)
      ? { agent, run: search.run }
      : { agent };
  },
  component: SubagentView,
});
