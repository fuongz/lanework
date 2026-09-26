import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentSession } from "#/../shared/terminal";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { useAgentSessions, workingOn } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";

const NONE: AgentSession[] = [];

type CardRef = { id: string; taskId: string | null };

/**
 * The agents on this machine working on `card` right now (FE-27): the rail's
 * conversations whose latest Lanework MCP call named it.
 *
 * ⚠️ This machine's only. An agent on somebody else's laptop is not in any
 * transcript here, so a card without a mark is not a card nobody is on.
 */
export function useCardAgents(card: CardRef): AgentSession[] {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const workspace = useWorkspaceKey(slug);
  return useAgentSessions(
    useShallow((state) =>
      workspace ? workingOn(state, workspace, card) : NONE,
    ),
  );
}

/** "Claude · working: Fix the login test", one line per agent. */
function describe(session: AgentSession): string {
  return `${TERMINAL_KIND_LABELS[session.agent]} · working: ${session.title}`;
}

/** "Claude · working: Fix the login test, Codex · working: …" */
export function describeAgents(agents: AgentSession[]): string {
  return agents.map(describe).join(", ");
}

/**
 * A card's status icon, or — while an agent works on it — the rail's orbit
 * spinner IN ITS PLACE (FE-27/D2a): no extra column, the way a working row
 * on the rail trades its agent icon for it. The tooltip names who.
 *
 * ⚠️ Not a control: it sits inside the card's link or its lane Select, and a
 * button in one of those is two targets in one place. Its words are in the
 * sr-only text for anybody who cannot hover — a parent with its own
 * `aria-label` has to say them itself (`describeAgents`).
 */
export function CardAgentsMark({
  card,
  children,
}: {
  card: CardRef;
  /** What shows while no agent is on the card: its status icon. */
  children?: ReactNode;
}) {
  const agents = useCardAgents(card);
  if (agents.length === 0) return children ?? null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="relative inline-grid size-4 shrink-0 place-items-center align-middle"
        data-card-agents={agents.length}
      >
        <OrbitSpinner className="text-foreground motion-reduce:hidden" />
        <span
          aria-hidden="true"
          className="bg-tone-emerald hidden size-1.5 rounded-full motion-reduce:block"
        />
        <span className="sr-only">{describeAgents(agents)}</span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        {agents.map((session) => (
          <span key={`${session.agent}:${session.id}`}>
            {describe(session)}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Issue detail's "Claude · working" line in the header (FE-27/D4): one
 * button per agent on the card, and a click opens that agent full size — the
 * tab already resuming it, or a new one.
 */
export function CardAgentsLine({ card }: { card: CardRef }) {
  const agents = useCardAgents(card);
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const workspace = useWorkspaceKey(slug);
  const resume = useAgentTerminals((state) => state.resume);
  const navigate = useNavigate();
  if (agents.length === 0 || !workspace || !slug) return null;
  const open = async (session: AgentSession) => {
    const terminal = await resume(workspace, session);
    if (terminal)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: terminal.id },
      });
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      {agents.map((session) => (
        <button
          key={`${session.agent}:${session.id}`}
          type="button"
          onClick={() => void open(session)}
          aria-label={`Open ${describe(session)}`}
          className="hover:bg-foreground/[0.06] flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors"
        >
          <span className="relative grid size-4 shrink-0 place-items-center">
            <OrbitSpinner className="text-foreground motion-reduce:hidden" />
            <span
              aria-hidden="true"
              className="bg-tone-emerald hidden size-1.5 rounded-full motion-reduce:block"
            />
          </span>
          <TerminalKindIcon
            kind={session.agent}
            className="size-3.5 shrink-0"
          />
          <span className="shrink-0 font-medium">
            {TERMINAL_KIND_LABELS[session.agent]}
          </span>
          <span className="text-muted-foreground shrink-0">· working</span>
          <span className="text-shimmer min-w-0 truncate">{session.title}</span>
        </button>
      ))}
    </div>
  );
}
