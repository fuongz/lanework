import { createFileRoute } from "@tanstack/react-router";
import type { TerminalAgent } from "#/../shared/terminal";
import { SubagentView } from "#/components/features/agents/subagent-view";
export const Route = createFileRoute(
  "/_app/w/$slug/agents/sub/$conversation/$sub",
)({
  // ⚠️ Which CLI's conversation it is: the ids alone do not say. Anything
  // but Codex is Claude, so a link from an older build still opens.
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent: TerminalAgent } => ({
    agent: search.agent === "codex" ? "codex" : "claude",
  }),
  component: SubagentView,
});
