import {
  Add01Icon,
  Loading03Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { AgentSession, TerminalSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { relativeTime, shortAge } from "#/lib/board-view";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useTerminal } from "#/stores/terminal";
import { RenameAgentDialog } from "./rename-agent-dialog";

/** Stable empty lists: a selector that allocated one would re-render forever. */
const NONE: AgentSession[] = [];
const NO_TERMINALS: TerminalSession[] = [];
/** Rows before "Show more" (FE-23/D4); the rest, up to the listing's 20, after. */
const FOLDED = 5;

/**
 * The rail's Agents group (FE-23): the Claude and Codex conversations this
 * project's folder has, newest first. A row opens its agent full size in the
 * main view — the one already resuming it, or a new one (FE-26).
 *
 * ⚠️ The rail IS the agents' tab list (FE-26/D1): the row whose agent is on
 * screen is marked the way an active link is, and a new conversation that
 * has not written a transcript yet still has a row, so it can be got back to.
 *
 * ⚠️ Hidden when there is nothing here to do: no agent CLI on this machine,
 * or no folder and no conversation (FE-23/D9). A folder with no conversation
 * yet keeps the group, for its + (FE-26/D3).
 */
export function AgentSessionsNav({
  workspace,
  slug,
  hasFolder,
  row,
  active: activeClass,
}: {
  workspace: string;
  slug: string;
  /** Whether this project has a folder here, so a new agent has somewhere to run. */
  hasFolder: boolean;
  /** The rail's row classes, so these read as its rows. */
  row: string;
  /** The rail's active-row classes. */
  active: string;
}) {
  const all = useAgentSessions((state) => state.byWorkspace[workspace] ?? NONE);
  const load = useAgentSessions((state) => state.load);
  const agents = useTerminal((state) => state.agents);
  const loadAgents = useTerminal((state) => state.loadAgents);
  const running = useAgentTerminals(
    (state) => state.sessions[workspace] ?? NO_TERMINALS,
  );
  const refreshRunning = useAgentTerminals((state) => state.refresh);
  const resume = useAgentTerminals((state) => state.resume);
  const start = useAgentTerminals((state) => state.start);
  const navigate = useNavigate();
  const { terminalId } = useParams({ strict: false }) as {
    terminalId?: string;
  };
  const onScreen = running.find((entry) => entry.id === terminalId);
  const live = useAgentSessions((state) => state.live);
  const watchActivity = useAgentSessions((state) => state.watchActivity);
  const pin = useAgentSessions((state) => state.pin);
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState<AgentSession | null>(null);

  useEffect(() => watchActivity(), [watchActivity]);

  // ⚠️ Re-read on entering the project, on focus, and when its terminals
  // change — an agent tab exiting is when a conversation gets its last
  // words and its title. Never on a timer, the Changes badge's rule.
  useEffect(() => {
    void load(workspace);
    void refreshRunning(workspace);
    const onFocus = () => void load(workspace);
    window.addEventListener("focus", onFocus);
    const off = window.desktop?.terminal.onChange((changed) => {
      if (changed !== workspace && changed !== "*") return;
      void load(workspace);
      void refreshRunning(workspace);
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      off?.();
    };
  }, [load, refreshRunning, workspace]);

  // ⚠️ Asked only once there is something to filter (FE-23/D8): the probe
  // starts the pty host and a shell, which a project with no conversation
  // has no reason to pay for.
  const any = all.length > 0 || hasFolder;
  useEffect(() => {
    if (any) void loadAgents();
  }, [any, loadAgents]);

  const sessions = useMemo(
    () => all.filter((session) => agents.includes(session.agent)),
    [all, agents],
  );

  /** Thinking or working: a turn open in its transcript (FE-25). */
  const isWorking = (session: AgentSession) =>
    live[agentKey(session)] ?? session.working;
  const now = Date.now();

  /**
   * Agents running a NEW conversation — started from + — whose transcript is
   * not listed yet: they need a row too, or leaving one would lose it.
   */
  const fresh = running.filter(
    (entry) =>
      entry.kind !== "shell" &&
      !entry.exit &&
      !sessions.some(
        (session) =>
          session.id === entry.resume && session.agent === entry.kind,
      ),
  );

  if (
    agents.length === 0 ||
    (sessions.length === 0 && !hasFolder && !fresh.length)
  )
    return null;

  const go = (next: TerminalSession | null) => {
    if (next)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: next.id },
      });
  };

  // ⚠️ Pinned first, newest pin on top, and ALWAYS shown — the fold only
  // ever hides unpinned rows (FE-25/D1).
  const pinned = sessions
    .filter((session) => session.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const rest = sessions.filter((session) => session.pinnedAt === null);
  const shown = [...pinned, ...(expanded ? rest : rest.slice(0, FOLDED))];
  return (
    <nav aria-label="Agents" className="flex flex-col gap-0.5">
      <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pb-1 pr-1">
        <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
          Agents
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="New agent"
            title="New agent"
            disabled={!hasFolder}
            className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50"
          >
            <HugeiconsIcon
              icon={Add01Icon}
              className="size-3.5"
              strokeWidth={2}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent}
                className="text-[13px]"
                onClick={() => void start(workspace, agent).then(go)}
              >
                <TerminalKindIcon kind={agent} className="size-4 shrink-0" />
                New {TERMINAL_KIND_LABELS[agent]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {fresh.map((entry) => {
        const agent = TERMINAL_KIND_LABELS[entry.kind];
        const current = entry.id === terminalId;
        return (
          <button
            key={entry.id}
            type="button"
            aria-current={current ? "page" : undefined}
            aria-label={`Open new ${agent} session`}
            onClick={() => go(entry)}
            className={`${row} w-full text-left ${current ? activeClass : ""}`}
          >
            <TerminalKindIcon kind={entry.kind} className="size-4 shrink-0" />
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              New {agent} session
            </span>
          </button>
        );
      })}
      {shown.map((session) => {
        const agent = TERMINAL_KIND_LABELS[session.agent];
        const working = isWorking(session);
        const isPinned = session.pinnedAt !== null;
        const current =
          onScreen?.resume === session.id && onScreen.kind === session.agent;
        return (
          <ContextMenu key={agentKey(session)}>
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  onClick={() => void resume(workspace, session).then(go)}
                  aria-current={current ? "page" : undefined}
                  aria-label={`Resume “${session.title}” in ${agent}`}
                  aria-busy={working || undefined}
                  title={`${session.title}\n${agent} · ${working ? "working" : relativeTime(session.updatedAt, now)}`}
                  className={`${row} w-full text-left ${current ? activeClass : ""}`}
                />
              }
            >
              {/* ⚠️ The spinner TAKES the agent's place rather than sitting
                  beside it (FE-25/D5): no extra column, and a row that spins
                  is still the only row that moved. Reduced motion gets a
                  still dot in the same place. */}
              {working ? (
                <span
                  className="relative grid size-4 shrink-0 place-items-center"
                  data-working=""
                >
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="text-muted-foreground size-4 animate-spin motion-reduce:hidden"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span
                    aria-hidden="true"
                    className="bg-tone-emerald hidden size-1.5 rounded-full motion-reduce:block"
                  />
                </span>
              ) : (
                <TerminalKindIcon
                  kind={session.agent}
                  className="size-4 shrink-0"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {isPinned && (
                <HugeiconsIcon
                  icon={PinIcon}
                  className="text-muted-foreground size-3 shrink-0"
                  strokeWidth={1.8}
                  aria-label="Pinned"
                />
              )}
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {shortAge(session.updatedAt, now)}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                className="text-[13px]"
                onClick={() => setRenaming(session)}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                className="text-[13px]"
                onClick={() => void pin(workspace, session, !isPinned)}
              >
                <HugeiconsIcon
                  icon={isPinned ? PinOffIcon : PinIcon}
                  strokeWidth={1.8}
                />
                {isPinned ? "Unpin" : "Pin"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {rest.length > FOLDED && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className={`${row} text-muted-foreground w-full text-left text-xs`}
        >
          {expanded ? "Show less" : `Show ${rest.length - FOLDED} more`}
        </button>
      )}
      <RenameAgentDialog
        workspace={workspace}
        session={renaming}
        onClose={() => setRenaming(null)}
      />
    </nav>
  );
}
