import type { ReactNode } from "react";
import { Fragment } from "react";
import type { AgentSession, TerminalSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { relativeTime } from "#/lib/relative-time";
import { agentKey } from "#/stores/agent-sessions";

/** A new conversation not listed yet, as the rail's hook describes one. */
interface PendingSlot {
  key: string;
  agent: AgentSession["agent"];
  label: string;
  working: boolean;
  current: boolean;
  open: () => void;
}

/**
 * The folded rail's Agents: one icon per agent (running, then pinned, then
 * the most recent idle ones) and no sub-agents.
 *
 * Draws nothing when every group is empty.
 */
export function AgentSessionsMini({
  pending,
  fresh,
  inRunning,
  pinned,
  recent,
  terminalId,
  now,
  isWorking,
  isRunning,
  isCurrent,
  openSession,
  go,
}: {
  pending: readonly PendingSlot[];
  fresh: readonly TerminalSession[];
  inRunning: readonly AgentSession[];
  pinned: readonly AgentSession[];
  /** The idle, unpinned conversations the folded list shows. */
  recent: readonly AgentSession[];
  /** The terminal on screen, if one is. */
  terminalId: string | undefined;
  now: number;
  isWorking: (session: AgentSession) => boolean;
  isRunning: (session: AgentSession) => boolean;
  isCurrent: (session: AgentSession) => boolean;
  openSession: (session: AgentSession) => void;
  go: (next: TerminalSession | null) => void;
}) {
  const slot = (
    key: string,
    kind: AgentSession["agent"],
    label: string,
    tip: string,
    state: "working" | "running" | null,
    current: boolean,
    onClick: () => void,
  ) => (
    <Tooltip key={key}>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-current={current ? "page" : undefined}
            aria-busy={state === "working" || undefined}
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] aria-[current]:bg-foreground/[0.08] aria-[current]:text-foreground relative grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150"
          />
        }
      >
        <TerminalKindIcon kind={kind} className="size-4" />
        {state && (
          <span
            aria-hidden="true"
            className={`ring-sidebar absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ${state === "working" ? "bg-tone-sky animate-pulse" : "bg-tone-emerald"}`}
          />
        )}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-56">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
  const sessionSlot = (session: AgentSession) => {
    const agent = TERMINAL_KIND_LABELS[session.agent];
    const working = isWorking(session);
    const terminal = isRunning(session);
    return slot(
      agentKey(session),
      session.agent,
      `Open “${session.title}”`,
      `${session.title} — ${agent}, ${working ? "working" : terminal ? "running" : relativeTime(session.updatedAt, now)}`,
      working ? "working" : terminal ? "running" : null,
      isCurrent(session),
      () => openSession(session),
    );
  };
  const slotGroups: [string, ReactNode[]][] = [
    [
      "running",
      [
        ...pending.map((entry) =>
          slot(
            entry.key,
            entry.agent,
            `Open “${entry.label}”`,
            `${entry.label} — ${TERMINAL_KIND_LABELS[entry.agent]}, ${entry.working ? "starting" : "new"}`,
            entry.working ? "working" : null,
            entry.current,
            entry.open,
          ),
        ),
        ...fresh.map((entry) => {
          const agent = TERMINAL_KIND_LABELS[entry.kind];
          return slot(
            entry.id,
            entry.kind as AgentSession["agent"],
            `Open new ${agent} session`,
            `New ${agent} session — running`,
            "running",
            entry.id === terminalId,
            () => go(entry),
          );
        }),
        ...inRunning.map(sessionSlot),
      ],
    ],
    ["pinned", pinned.map(sessionSlot)],
    ["recent", recent.map(sessionSlot)],
  ];
  const groups = slotGroups.filter(([, group]) => group.length > 0);
  if (groups.length === 0) return null;
  return (
    <TooltipProvider delay={300}>
      <nav aria-label="Agents" className="flex flex-col items-center gap-1">
        {groups.map(([name, group], index) => (
          <Fragment key={name}>
            {index > 0 && (
              <span
                aria-hidden="true"
                className="bg-foreground/10 my-0.5 h-px w-5"
              />
            )}
            {group}
          </Fragment>
        ))}
      </nav>
    </TooltipProvider>
  );
}
