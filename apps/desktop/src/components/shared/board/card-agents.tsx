import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BoardMember, BoardPresence } from "#/../shared/projects";
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
import { useProjectKey } from "#/hooks/use-project-key";
import { relativeTime } from "#/lib/relative-time";
import { useAgentSessions, workingOn } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
import {
  cloudAgentsOn,
  presenceKind,
  useBoardPresence,
} from "#/stores/board-presence";
import { useSession } from "#/stores/session";

const NO_SESSIONS: AgentSession[] = [];
const NO_ROWS: BoardPresence[] = [];
const NO_MEMBERS: BoardMember[] = [];

type CardRef = { id: string; taskId: string | null };

/**
 * One agent on a card: this machine's, known from its transcript, or one the
 * service saw calling about it from anywhere.
 */
type CardAgent =
  | { from: "local"; session: AgentSession }
  | { from: "cloud"; row: BoardPresence; name: string };

/**
 * The agents working on `card` right now.
 *
 * This machine's rail conversations whose latest Lanework MCP call named it
 * come first, then every other one the service saw in the last few minutes,
 * minus the service's copy of the first kind (BE-16/D7).
 */
export function useCardAgents(card: CardRef): CardAgent[] {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const project = useProjectKey(slug);
  const sessions = useAgentSessions(
    useShallow((state) =>
      project ? workingOn(state, project, card) : NO_SESSIONS,
    ),
  );
  const me = useSession(
    useShallow((state) => {
      const principal = state.session?.principal;
      return principal?.kind === "machine"
        ? { userId: principal.userId, machineId: principal.machineId }
        : { userId: null, machineId: null };
    }),
  );
  const rows = useBoardPresence(
    useShallow((state) =>
      project
        ? cloudAgentsOn(
            state,
            project,
            card.id,
            me,
            sessions.map((session) => session.agent),
          )
        : NO_ROWS,
    ),
  );
  const members = useBoard((state) => state.view?.members ?? NO_MEMBERS);
  return [
    ...sessions.map((session) => ({ from: "local" as const, session })),
    ...rows.map((row) => ({
      from: "cloud" as const,
      row,
      name:
        members.find((member) => member.userId === row.userId)?.name ??
        "Someone",
    })),
  ];
}

/** "Claude", or the client's own slug for an agent this app has no mark for. */
function agentLabel(agent: string): string {
  const kind = presenceKind(agent);
  return kind ? TERMINAL_KIND_LABELS[kind] : agent;
}

/**
 * "Claude working: Fix the login test" for this machine's agent, "Claude on
 * Decio, 2 minutes ago" for one the service saw (BE-16/D6a).
 */
function describe(agent: CardAgent, now: number): string {
  if (agent.from === "local")
    return `${TERMINAL_KIND_LABELS[agent.session.agent]} working: ${agent.session.title}`;
  return `${agentLabel(agent.row.agent)} on ${agent.name}, ${relativeTime(agent.row.lastSeenAt, now)}`;
}

/** Every agent on the card, one after another, for an `aria-label`. */
export function describeAgents(agents: CardAgent[]): string {
  const now = Date.now();
  return agents.map((agent) => describe(agent, now)).join(", ");
}

function agentKey(agent: CardAgent): string {
  return agent.from === "local"
    ? `local:${agent.session.agent}:${agent.session.id}`
    : `cloud:${agent.row.userId}:${agent.row.agent}`;
}

/** The spinner, with a still dot in its place for reduced motion. */
function WorkingMark() {
  return (
    <>
      {/* The rail's size (`working-mark.tsx`), so it fills the status
          icon's 14px slot instead of standing taller than it. */}
      <OrbitSpinner className="text-foreground size-3 gap-px motion-reduce:hidden" />
      <span
        aria-hidden="true"
        className="bg-tone-emerald hidden size-1.5 rounded-full motion-reduce:block"
      />
    </>
  );
}

/**
 * A card's status icon, or the rail's orbit spinner in its place while an
 * agent works on it.
 *
 * No extra column, the way a working row on the rail trades its agent icon
 * for it (FE-27/D2a). The tooltip names who. An agent on another machine gets
 * the same spinner (BE-16/D6a); the tooltip says whose it is and when the
 * service last heard from it.
 *
 * NOTE: Not a control. It sits inside the card's link or its lane Select, and
 * a button in one of those is two targets in one place. Its words are in the
 * sr-only text for anybody who cannot hover; a parent with its own
 * `aria-label` has to say them itself ({@link describeAgents}).
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
  const now = Date.now();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="relative inline-grid size-3.5 shrink-0 place-items-center align-middle"
        data-card-agents={agents.length}
      >
        <WorkingMark />
        <span className="sr-only">{describeAgents(agents)}</span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        {agents.map((agent) => (
          <span key={agentKey(agent)}>{describe(agent, now)}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Issue detail's "Claude working" line in the header (FE-27/D4).
 *
 * One button per agent on this machine; a click opens that agent full size,
 * in the tab already resuming it or a new one. An agent the service saw is
 * listed after them but is not a button (BE-16/D6a): its session is on
 * another machine, and there is nothing here to open.
 */
export function CardAgentsLine({ card }: { card: CardRef }) {
  const agents = useCardAgents(card);
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const project = useProjectKey(slug);
  const resume = useAgentTerminals((state) => state.resume);
  const navigate = useNavigate();
  if (agents.length === 0 || !project || !slug) return null;
  const now = Date.now();
  const open = async (session: AgentSession) => {
    const terminal = await resume(project, session);
    if (terminal)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: terminal.id },
      });
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      {agents.map((agent) => {
        if (agent.from === "cloud") {
          const kind = presenceKind(agent.row.agent);
          return (
            <div
              key={agentKey(agent)}
              data-card-agent="cloud"
              className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
            >
              <span className="relative grid size-4 shrink-0 place-items-center">
                <WorkingMark />
              </span>
              {kind && (
                <TerminalKindIcon kind={kind} className="size-3.5 shrink-0" />
              )}
              <span className="shrink-0 font-medium">
                {agentLabel(agent.row.agent)}
              </span>
              <span className="text-muted-foreground min-w-0 truncate">
                on {agent.name}
              </span>
              <span className="text-muted-foreground flex shrink-0 items-center gap-1">
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="size-3"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {relativeTime(agent.row.lastSeenAt, now)}
              </span>
            </div>
          );
        }
        const { session } = agent;
        return (
          <button
            key={agentKey(agent)}
            type="button"
            onClick={() => void open(session)}
            aria-label={`Open ${describe(agent, now)}`}
            className="hover:bg-foreground/[0.06] flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors"
          >
            <span className="relative grid size-4 shrink-0 place-items-center">
              <WorkingMark />
            </span>
            <TerminalKindIcon
              kind={session.agent}
              className="size-3.5 shrink-0"
            />
            <span className="shrink-0 font-medium">
              {TERMINAL_KIND_LABELS[session.agent]}
            </span>
            <span className="text-muted-foreground shrink-0">working on</span>
            <span className="text-shimmer min-w-0 truncate">
              {session.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}
