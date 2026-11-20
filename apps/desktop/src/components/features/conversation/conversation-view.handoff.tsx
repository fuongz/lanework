import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AGENT_LABELS,
  type ConversationHandoff,
  type ConversationHandoffLinks,
  modelName,
} from "#/../shared/conversation";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { useAgentSessions } from "#/stores/agent-sessions";

const NONE: ConversationHandoffLinks = { from: null, to: [] };

/**
 * Where this conversation was handed off from and continued in. Read on
 * open, and again whenever `seen` changes (a turn landed, a handoff sent).
 */
export function useHandoffLinks(
  project: string | null,
  id: string,
  seen: unknown,
): ConversationHandoffLinks {
  const [links, setLinks] = useState<ConversationHandoffLinks>(NONE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seen` only says when to read again.
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!project || !surface) return;
    let gone = false;
    void surface
      .handoffLinks(project, id)
      .then((next) => {
        if (!gone) setLinks(next);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [project, id, seen]);
  return links;
}

/** "14:30" today, else "Nov 18, 14:30". */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], {
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What the new chat was given, for the line's hover. */
function carriedText(handoff: ConversationHandoff): string {
  const { summary, turns, omitted } = handoff.carried;
  const parts = [
    summary ? "its summary" : null,
    turns ? `${turns} recent ${turns === 1 ? "turn" : "turns"}` : null,
  ].filter(Boolean);
  const carried = parts.length
    ? `Carried ${parts.join(" and ")}`
    : "Carried no turns";
  return omitted
    ? `${carried}; ${omitted} older ${omitted === 1 ? "turn" : "turns"} did not fit.`
    : `${carried}.`;
}

/**
 * One handoff as a line across the chat, the "Load earlier turns" divider's
 * shape: at the top of the new chat ("Continued from"), at the end of the
 * old one ("Continued in"). The name opens the other chat.
 */
export function HandoffLine({
  slug,
  project,
  handoff,
  side,
}: {
  slug: string;
  project: string;
  handoff: ConversationHandoff;
  /** `from`: this chat is the new one. `to`: this chat is the old one. */
  side: "from" | "to";
}) {
  const navigate = useNavigate();
  const other =
    side === "from"
      ? { ...handoff.from, model: null as string | null }
      : handoff.to;
  const title = useAgentSessions(
    (state) =>
      state.byProject[project]?.find(
        (entry) =>
          entry.agent === other.agent && entry.id === other.conversation,
      )?.title,
  );
  const harness = AGENT_LABELS[other.agent];
  const model = other.model ? (modelName(other.model) ?? other.model) : null;
  const time = when(handoff.at);
  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <span aria-hidden="true" className="bg-border h-px flex-1" />
      <p
        className="text-muted-foreground flex min-w-0 shrink items-center gap-1.5 text-xs"
        title={carriedText(handoff)}
      >
        <span className="shrink-0">
          {side === "from" ? "Continued from" : "Continued in"}
        </span>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/w/$slug/agents/chat/$conversation",
              params: { slug, conversation: other.conversation },
            })
          }
          className="text-foreground/80 hover:text-foreground focus-visible:ring-ring/40 flex min-w-0 items-center gap-1.5 rounded-md px-1 font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none"
        >
          <TerminalKindIcon kind={other.agent} className="size-3.5 shrink-0" />
          <span className="truncate">
            {title || (model ? `${harness} (${model})` : `a ${harness} chat`)}
          </span>
        </button>
        {time && <span className="shrink-0 tabular-nums">{time}</span>}
      </p>
      <span aria-hidden="true" className="bg-border h-px flex-1" />
    </div>
  );
}
