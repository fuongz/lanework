import { useEffect, useMemo, useState } from "react";
import type { AgentSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { relativeTime, shortAge } from "#/lib/board-view";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useTerminal } from "#/stores/terminal";

/** Stable empty list: a selector that allocated one would re-render forever. */
const NONE: AgentSession[] = [];
/** Rows before "Show more" (FE-23/D4); the rest, up to the listing's 20, after. */
const FOLDED = 5;

/**
 * The rail's Agents group (FE-23): the Claude and Codex conversations this
 * project's folder has, newest first. A row resumes its conversation in a
 * terminal tab — or shows the tab already doing so.
 *
 * ⚠️ Hidden, not empty, when there is nothing to list (FE-23/D9): no folder
 * here, no conversation yet, or none from a CLI this machine still has.
 */
export function AgentSessionsNav({
  workspace,
  row,
}: {
  workspace: string;
  /** The rail's row classes, so these read as its rows. */
  row: string;
}) {
  const all = useAgentSessions((state) => state.byWorkspace[workspace] ?? NONE);
  const load = useAgentSessions((state) => state.load);
  const agents = useTerminal((state) => state.agents);
  const loadAgents = useTerminal((state) => state.loadAgents);
  const resumeAgent = useTerminal((state) => state.resumeAgent);
  const [expanded, setExpanded] = useState(false);

  // ⚠️ Re-read on entering the project, on focus, and when its terminals
  // change — an agent tab exiting is when a conversation gets its last
  // words and its title. Never on a timer, the Changes badge's rule.
  useEffect(() => {
    void load(workspace);
    const onFocus = () => void load(workspace);
    window.addEventListener("focus", onFocus);
    const off = window.desktop?.terminal.onChange((changed) => {
      if (changed === workspace || changed === "*") void load(workspace);
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      off?.();
    };
  }, [load, workspace]);

  // ⚠️ Asked only once there is something to filter (FE-23/D8): the probe
  // starts the pty host and a shell, which a project with no conversation
  // has no reason to pay for.
  const any = all.length > 0;
  useEffect(() => {
    if (any) void loadAgents();
  }, [any, loadAgents]);

  const sessions = useMemo(
    () => all.filter((session) => agents.includes(session.agent)),
    [all, agents],
  );
  if (sessions.length === 0) return null;

  const shown = expanded ? sessions : sessions.slice(0, FOLDED);
  const now = Date.now();
  return (
    <nav aria-label="Agents" className="flex flex-col gap-0.5">
      <span className="text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase">
        Agents
      </span>
      {shown.map((session) => {
        const agent = TERMINAL_KIND_LABELS[session.agent];
        return (
          <button
            key={`${session.agent}:${session.id}`}
            type="button"
            onClick={() => void resumeAgent(workspace, session)}
            aria-label={`Resume “${session.title}” in ${agent}`}
            title={`${session.title}\n${agent} · ${relativeTime(session.updatedAt, now)}`}
            className={`${row} w-full text-left`}
          >
            <TerminalKindIcon
              kind={session.agent}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {shortAge(session.updatedAt, now)}
            </span>
          </button>
        );
      })}
      {sessions.length > FOLDED && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className={`${row} text-muted-foreground w-full text-left text-xs`}
        >
          {expanded ? "Show less" : `Show ${sessions.length - FOLDED} more`}
        </button>
      )}
    </nav>
  );
}
