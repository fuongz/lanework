import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ToolCall } from "#/../shared/conversation";
import type { TerminalAgent } from "#/../shared/terminal";
import { isAgentSessionId } from "#/../shared/terminal";
import { StatusPing } from "#/components/shared/agents/status-ping";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { cn } from "#/lib/utils";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";

/** A session a conductor started or followed up, as its CLI receipt says. */
export interface LaunchedSession {
  sessionId: string;
  title: string;
  agent: TerminalAgent | null;
}

/** `sessions.start` or `sessions.send`, run as a shell command. */
const SESSION_CALL = /\bsessions\.(?:start|send)\b/;

/** The receipt a call printed: its last line that is an `ok` JSON object. */
function receiptOf(call: ToolCall): LaunchedSession | null {
  if (call.kind !== "command" || call.error || !call.output) return null;
  if (!SESSION_CALL.test(call.input)) return null;
  const lines = call.output.trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const reply = JSON.parse(line) as {
        ok?: unknown;
        result?: { sessionId?: unknown; title?: unknown; agent?: unknown };
      };
      const result = reply.result;
      if (reply.ok !== true || !isAgentSessionId(result?.sessionId))
        return null;
      return {
        sessionId: result.sessionId,
        title:
          typeof result.title === "string" && result.title
            ? result.title
            : "Session",
        agent:
          result.agent === "claude" || result.agent === "codex"
            ? result.agent
            : null,
      };
    } catch {
      // Not the receipt: an earlier line may be.
    }
  }
  return null;
}

/** The sessions a group of calls started or followed up, once each. */
export function launchedSessions(
  calls: readonly ToolCall[],
): LaunchedSession[] {
  const found = new Map<string, LaunchedSession>();
  for (const call of calls) {
    const receipt = receiptOf(call);
    if (receipt && !found.has(receipt.sessionId))
      found.set(receipt.sessionId, receipt);
  }
  return [...found.values()];
}

/**
 * A session the conductor started, under the commands that started it: its
 * agent, the state the rail would show, its name. A click opens it.
 */
export function LaunchedSessionCard({
  session,
  slug,
}: {
  session: LaunchedSession;
  slug: string;
}) {
  const navigate = useNavigate();
  const workspace = useWorkspaceKey(slug);
  const listed = useAgentSessions((state) =>
    workspace
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.id === session.sessionId,
        )
      : undefined,
  );
  const agent = listed?.agent ?? session.agent ?? "claude";
  const live = useAgentSessions(
    (state) => state.live[agentKey({ agent, id: session.sessionId })],
  );
  const awaiting = useAwaiting((state) =>
    workspace
      ? Boolean(state.byKey[awaitingKey(workspace, session.sessionId)])
      : false,
  );
  const working = !awaiting && (live ?? listed?.working ?? false);
  const title = listed?.title || session.title;
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: session.sessionId },
        })
      }
      title={`Open “${title}”`}
      aria-label={`Open “${title}”${awaiting ? ", waiting for you" : working ? ", working" : ""}`}
      className="group/launched border-border hover:bg-foreground/[0.03] flex max-w-full min-w-0 items-center gap-2.5 self-start rounded-xl border px-3 py-2 text-left text-[13px] transition-colors"
    >
      <span className="relative flex shrink-0">
        <TerminalKindIcon kind={agent} className="size-3.5" />
        {(awaiting || working) && (
          <StatusPing tone={awaiting ? "awaiting" : "working"} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          working && "text-shimmer",
        )}
      >
        {title}
      </span>
      {awaiting && (
        <span className="text-destructive shrink-0 text-xs">
          Waiting for you
        </span>
      )}
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="text-muted-foreground group-hover/launched:text-foreground size-3.5 shrink-0 transition-colors"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </button>
  );
}
