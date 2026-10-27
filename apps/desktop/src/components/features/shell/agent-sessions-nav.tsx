import {
  Add01Icon,
  ArrowRight01Icon,
  PinIcon,
  PinOffIcon,
  Search01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { OrchestrationTask } from "#/../shared/orchestration";
import type {
  AgentSession,
  AgentSubagent,
  TerminalSession,
} from "#/../shared/terminal";
import {
  backgroundCue,
  canStop,
  pidText,
  TASK_KIND_ICONS,
  taskLabel,
  useStopBackgroundTask,
} from "#/components/shared/agents/background-tasks";
import { factsSummary } from "#/components/shared/agents/conversation-facts";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import { useChatAgent } from "#/components/shared/conversation/chat-agent";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { liveRun, useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { relativeTime, shortAge } from "#/lib/board-view";
import { ipcMessage } from "#/lib/ipc-error";
import {
  taskLabel as workerLabel,
  taskTone as workerTone,
} from "#/lib/orchestration-status";
import { cn } from "#/lib/utils";
import { useAgentFacts } from "#/stores/agent-facts";
import {
  agentKey,
  subagentKey,
  useAgentSessions,
} from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { NO_CHATS, useChatEngines } from "#/stores/chat-engines";
import { type NewChat, useNewChats } from "#/stores/new-chats";
import { useTerminal } from "#/stores/terminal";
import { AgentSessionSearch } from "./agent-session-search";
import { CodexGoalBadge } from "./codex-goal-badge";
import { RenameAgentDialog } from "./rename-agent-dialog";

/** Stable empty lists: a selector that allocates one re-renders forever. */
const NONE: AgentSession[] = [];
const NO_TERMINALS: TerminalSession[] = [];
const NO_TASKS: OrchestrationTask[] = [];
/**
 * Rows before "Show more"; the rest, up to the listing's 20, after it
 * (FE-23/D4).
 */
const FOLDED = 5;
/** A conversation's sub-agent rows before its own "Show more" (FE-33/D4). */
const SUBAGENTS_FOLDED = 3;
/**
 * A sub-agent row: shorter than a conversation's, and indented so its icon
 * sits under its conversation's title (`px-2` + the 12px icon + `gap-2.5`).
 */
const SUB_ROW = "h-[26px] w-full ps-[30px] text-left text-xs";
/**
 * How long a pointer rests on a row before its numbers are read (FE-38/D5).
 */
const PEEK_MS = 150;
/** A row's numbers read this recently are shown again, not read again. */
const FACTS_FRESH_MS = 15_000;

/**
 * A row's quick actions, shown on hover or keyboard focus in place of its age.
 *
 * Stop for a running agent, then Pin, rightmost like the rail's others.
 *
 * NOTE: Siblings laid over the row, not inside it: the row is a button, and a
 * button cannot hold another. Both live in the context menu too.
 */
function QuickActions({
  onStop,
  pin,
}: {
  onStop?: () => void;
  pin?: { pinned: boolean; onToggle: () => void };
}) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
      {onStop && (
        <QuickAction
          label="Stop"
          icon={StopIcon}
          onClick={onStop}
          className="hover:text-destructive"
        />
      )}
      {pin && (
        <QuickAction
          label={pin.pinned ? "Unpin" : "Pin"}
          icon={pin.pinned ? PinOffIcon : PinIcon}
          onClick={pin.onToggle}
        />
      )}
    </div>
  );
}

/** One icon-only quick action; its tooltip says what it does before a click. */
function QuickAction({
  label,
  icon,
  onClick,
  className = "",
}: {
  label: string;
  icon: IconSvgElement;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={`text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] flex size-5 items-center justify-center rounded-md transition-colors ${className}`}
          />
        }
      >
        <HugeiconsIcon icon={icon} className="size-3.5" strokeWidth={1.8} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A conversation's background shells and monitors still running, as rows
 * under it beside its sub-agents' (FE-42/D1).
 *
 * Its background agents are already sub-agent rows. A row opens the task's
 * own page. Mounted only for a conversation whose listing counts one running,
 * so the rail reads no task list for the rest.
 */
function BackgroundShellRows({
  workspace,
  slug,
  session,
  row,
  active,
  viewingTask,
  now,
}: {
  workspace: string;
  slug: string;
  session: AgentSession;
  row: string;
  active: string;
  /** The task whose page is on screen, if one is. */
  viewingTask: string | undefined;
  now: number;
}) {
  const navigate = useNavigate();
  const stopping = useStopBackgroundTask(workspace, session.id);
  const { tasks } = useBackgroundTasks(
    workspace,
    session.id,
    `${backgroundCue(session)}:${stopping.revision}`,
  );
  const shells = (tasks ?? []).filter(
    (task) => task.status === "running" && task.kind !== "agent",
  );
  return (
    <>
      {" "}
      {stopping.feedback}
      {shells.map((task) => {
        const viewed = viewingTask === task.id;
        const name = taskLabel(task);
        const pid = pidText(task);
        return (
          <ContextMenu key={task.id}>
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: "/w/$slug/agents/task/$conversation/$task",
                      params: { slug, conversation: session.id, task: task.id },
                    })
                  }
                  aria-current={viewed ? "page" : undefined}
                  aria-label={`${name}, a background ${task.kind} of “${session.title}”. ${task.kind === "workflow" ? "Open its agents" : "Open its output"}`}
                  title={`${task.command ?? name}\nBackground ${task.kind}${pid ? ` (${pid})` : ""}, running since ${relativeTime(task.startedAt, now)}`}
                  className={cn(row, SUB_ROW, viewed && active)}
                />
              }
            >
              {/* Its kind on the left, so a row says what runs; the spinner on
            the right, beside its age. */}
              <HugeiconsIcon
                icon={TASK_KIND_ICONS[task.kind]}
                className="text-muted-foreground size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span
                className={`min-w-0 flex-1 truncate ${viewed ? "" : "text-muted-foreground"}`}
              >
                {name}
              </span>
              <WorkingMark />
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {shortAge(task.startedAt, now)}
              </span>
            </ContextMenuTrigger>
            {canStop(task) && (
              <ContextMenuContent>
                <StopItem onStop={() => stopping.requestStop(task)} />
              </ContextMenuContent>
            )}
          </ContextMenu>
        );
      })}
    </>
  );
}

/** What hover hides to make room for the quick actions. */
const MAKES_ROOM = "group-hover/row:invisible group-focus-within/row:invisible";

/** A running agent's Stop, in its row's context menu. */
function StopItem({ onStop }: { onStop: () => void }) {
  return (
    <ContextMenuItem variant="destructive" onClick={onStop}>
      Stop
    </ContextMenuItem>
  );
}

/**
 * The rail's Agents group: the Claude and Codex conversations this project's
 * folder has, newest first.
 *
 * A row opens its agent full size in the main view: the one already resuming
 * it, or a new one.
 *
 * - The rail is the agents' tab list (FE-26/D1). The row whose agent is on
 *   screen is marked the way an active link is, and a new conversation with
 *   no transcript yet still has a row, so it can be got back to.
 * - Three groups, and a row is in exactly one: Running holds the agents whose
 *   pty is alive, Stop in each one's context menu; Pinned the pinned
 *   transcripts; Agents the rest. Running wins over Pinned: a pinned
 *   conversation that is resumed moves up to Running, and back on Stop.
 * - Hidden when there is nothing here to do: no agent CLI on this machine, or
 *   no folder and no conversation (FE-23/D9). A folder with no conversation
 *   yet keeps the group, for its + (FE-26/D3).
 */
export function AgentSessionsNav({
  workspace,
  slug,
  hasFolder,
  row,
  active: activeClass,
  mini = false,
}: {
  workspace: string;
  slug: string;
  /**
   * The folded rail's form: one icon per agent (running, then pinned, then
   * the most recent idle ones) and no sub-agents.
   */
  mini?: boolean;
  /** Whether this project has a folder here for a new agent to run in. */
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
  // Conversations the chat runs count as Running too, like a live tab.
  const chats = useChatEngines((state) => state.alive[workspace] ?? NO_CHATS);
  // Orchestration runs (FE-87): a lead's workers nest under its row.
  const runs = useOrchestrationRuns(workspace);
  const refreshChats = useChatEngines((state) => state.refresh);
  const watchChats = useChatEngines((state) => state.watch);
  const stop = useAgentTerminals((state) => state.stop);
  const navigate = useNavigate();
  const {
    terminalId,
    conversation: viewing,
    sub: viewingSub,
    task: viewingTask,
  } = useParams({
    strict: false,
  }) as {
    terminalId?: string;
    conversation?: string;
    sub?: string;
    task?: string;
  };
  // The sub-agent viewer's: which CLI's conversation `viewing` is.
  const { agent: viewingAgent } = useSearch({ strict: false }) as {
    agent?: string;
  };
  const onScreen = running.find((entry) => entry.id === terminalId);
  const live = useAgentSessions((state) => state.live);
  const watchActivity = useAgentSessions((state) => state.watchActivity);
  const pin = useAgentSessions((state) => state.pin);
  const remove = useAgentSessions((state) => state.remove);
  const archive = useAgentSessions((state) => state.archive);
  const openSubagents = useAgentSessions((state) => state.open);
  const setOpenSubagents = useAgentSessions((state) => state.setOpen);
  // The new-conversation page, and what it started that is not listed yet.
  const onNewPage = useRouterState({
    select: (state) => state.location.pathname === `/w/${slug}/agents/chat/new`,
  });
  const chatAgent = useChatAgent();
  const starting = useNewChats((state) => state.starting[workspace]);
  const started = useNewChats((state) => state.started);
  const forgetStarted = useNewChats((state) => state.forget);
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  /** Conversations whose sub-agents are all shown, past the fold (FE-33/D4). */
  const [allSubagents, setAllSubagents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [renaming, setRenaming] = useState<AgentSession | null>(null);
  /** Why an Archive was refused; it has no dialog of its own to show it in. */
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** The conversation whose transcript is about to go for good. */
  const [deleting, setDeleting] = useState<{
    session: AgentSession;
    busy: boolean;
    error: string | null;
  } | null>(null);
  // The tooltip lines, not the facts: a view open on an agent reads its facts
  // on every write, and the rail redraws only when a line changes.
  const summaries = useAgentFacts(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.byKey).map(([key, entry]) => [
          key,
          factsSummary(entry.facts),
        ]),
      ),
    ),
  );
  const readFacts = useAgentFacts((state) => state.read);
  const peeking = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Read a row's cost and context, for its tooltip (FE-38/D5).
   *
   * Only once a pointer rests on that row: never for the whole list, and not
   * for one it merely passes over on its way down the rail.
   */
  const peek = (session: AgentSession) => {
    if (peeking.current) clearTimeout(peeking.current);
    peeking.current = setTimeout(() => {
      const known = useAgentFacts.getState().byKey[agentKey(session)];
      if (!known || Date.now() - known.at > FACTS_FRESH_MS)
        readFacts(workspace, session);
    }, PEEK_MS);
  };
  const unpeek = () => {
    if (peeking.current) clearTimeout(peeking.current);
    peeking.current = null;
  };
  /** The working agent whose Stop asked first (FE-26/D5), as the view does. */
  const [confirming, setConfirming] = useState<{
    stop: () => void;
    label: string;
  } | null>(null);

  useEffect(() => watchActivity(), [watchActivity]);
  useEffect(() => watchChats(), [watchChats]);
  useEffect(() => {
    void refreshChats(workspace);
  }, [refreshChats, workspace]);

  // Re-read on entering the project, on focus, and when its terminals change:
  // an agent tab exiting is when a conversation gets its last words and its
  // title. Never on a timer, the Changes badge's rule.
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

  // A started conversation stops standing in once the listing has it.
  useEffect(() => {
    const listed = all
      .map((session) => session.id)
      .filter((id) => id in started);
    if (listed.length > 0) forgetStarted(listed);
  }, [all, started, forgetStarted]);

  // And the listing is read again as its first turn lands, not only on focus
  // or a terminal change: that is when its transcript (and title) appears.
  const waiting = Object.values(started).some(
    (chat) => chat.workspace === workspace,
  );
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!waiting || !surface) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = surface.onEvent((event) => {
      if (
        (event.type !== "state" &&
          event.type !== "turn" &&
          event.type !== "moved") ||
        event.workspace !== workspace ||
        !(event.conversation in useNewChats.getState().started) ||
        timer
      )
        return;
      timer = setTimeout(() => {
        timer = null;
        void load(workspace);
      }, 500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [waiting, load, workspace]);

  // Asked only once there is something to filter (FE-23/D8): the probe starts
  // the pty host and a shell, which a project with no conversation has no
  // reason to pay for.
  const any = all.length > 0 || hasFolder;
  useEffect(() => {
    if (any) void loadAgents();
  }, [any, loadAgents]);

  const sessions = useMemo(
    () => all.filter((session) => agents.includes(session.agent)),
    [all, agents],
  );

  /** Thinking or working: a turn open in its transcript. */
  const isWorking = (session: AgentSession) =>
    live[agentKey(session)] ?? session.working;
  /** A sub-agent still going, as the watcher last said, else the listing. */
  const subagentWorking = (session: AgentSession, sub: AgentSubagent) =>
    live[subagentKey(session, sub)] ?? sub.working;
  const now = Date.now();

  /** The live terminal resuming `session`, if one is. */
  const runningFor = (session: AgentSession) =>
    running.find(
      (entry) =>
        entry.resume === session.id &&
        entry.kind === session.agent &&
        !entry.exit,
    );
  /** The chat's own engine is running `session`. */
  const chatFor = (session: AgentSession) => chats.includes(session.id);
  /** The orchestration run `session` leads, while it still holds workers. */
  const runFor = (session: AgentSession) =>
    runs.find(
      (run) =>
        liveRun(run) &&
        run.lead === session.id &&
        run.leadAgent === session.agent,
    );
  /**
   * Running: a live terminal on it, the chat's engine, or a run it leads:
   * its workers go on while the lead waits between turns.
   */
  const isRunning = (session: AgentSession) =>
    Boolean(runningFor(session)) ||
    chatFor(session) ||
    Boolean(runFor(session));

  /**
   * Agents running a new conversation, started from +, whose transcript is
   * not listed yet. They need a row too, or leaving one would lose it.
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

  /**
   * Conversations from the new-conversation page with no listed row yet: the
   * page itself while it is open or its first message is starting, then
   * each one started, under its first message, until the listing has it.
   */
  const pending: {
    key: string;
    agent: NewChat["agent"];
    label: string;
    working: boolean;
    current: boolean;
    open: () => void;
  }[] = [];
  if (onNewPage || starting)
    pending.push({
      key: "new",
      agent: starting?.agent ?? chatAgent ?? "claude",
      label: starting?.text.trim() || "New session",
      working: Boolean(starting),
      current: onNewPage,
      open: () =>
        void navigate({ to: "/w/$slug/agents/chat/new", params: { slug } }),
    });
  for (const [id, chat] of Object.entries(started)) {
    if (
      chat.workspace !== workspace ||
      all.some((session) => session.id === id)
    )
      continue;
    pending.push({
      key: id,
      agent: chat.agent,
      label: chat.text.trim() || "New session",
      working: true,
      current: viewing === id && !viewingSub && !viewingTask,
      open: () =>
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: id },
        }),
    });
  }

  if (agents.length === 0) return null;

  // A conversation is in one group: Running while its agent is, Agents once
  // it is only a transcript again. Never both, so the rail marks one row as
  // on screen.
  const inRunning = sessions.filter(isRunning);
  const idle = sessions.filter((session) => !isRunning(session));
  const hasRunning =
    pending.length > 0 || fresh.length > 0 || inRunning.length > 0;
  if (!hasRunning && idle.length === 0 && !hasFolder) return null;

  const go = (next: TerminalSession | null) => {
    if (next)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: next.id },
      });
  };

  /**
   * Open a conversation's row: Claude's and Codex's open as a chat (FE-62/D3).
   *
   * Unless a tab is running it, where it was last used; then that tab opens.
   */
  const openSession = (session: AgentSession) => {
    const tab = runningFor(session);
    if (tab) go(tab);
    else
      void navigate({
        to: "/w/$slug/agents/chat/$conversation",
        params: { slug, conversation: session.id },
      });
  };
  /** On screen: its terminal, or its chat. */
  const isCurrent = (session: AgentSession) =>
    (onScreen?.resume === session.id && onScreen.kind === session.agent) ||
    (viewing === session.id && !viewingSub && !viewingTask);

  // Pinned is its own group, newest pin on top, and always shown in full: the
  // fold only hides Agents' rows (FE-25/D1).
  const pinned = idle
    .filter((session) => session.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const rest = idle.filter((session) => session.pinnedAt === null);
  const shown = expanded ? rest : rest.slice(0, FOLDED);

  if (mini) {
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
      ["recent", rest.slice(0, FOLDED).map(sessionSlot)],
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

  const sessionRow = (session: AgentSession, inPinned = false) => {
    const agent = TERMINAL_KIND_LABELS[session.agent];
    const working = isWorking(session);
    const key = agentKey(session);
    const subagents = session.subagents;
    // Working first, then newest (FE-33/D4): the ones still going are the
    // ones worth seeing above the fold.
    const ordered = subagents
      .map((sub) => ({ sub, working: subagentWorking(session, sub) }))
      .sort(
        (a, b) =>
          Number(b.working) - Number(a.working) ||
          b.sub.updatedAt.localeCompare(a.sub.updatedAt),
      );
    const going = ordered.filter((entry) => entry.working).length;
    // Its orchestration run's workers, in the run's order (FE-87).
    const workers = runFor(session)?.tasks ?? NO_TASKS;
    const workersGoing = workers.filter(
      (task) => task.status === "running" || task.status === "cancelling",
    ).length;
    const children = subagents.length + workers.length;
    const childrenGoing = going + workersGoing;
    // Its background tasks still running; only Claude counts them (FE-42/D1).
    const background =
      session.agent === "claude" ? session.background.running : 0;
    const nested = children > 0 || background > 0;
    // Unset follows them: open while one is going (FE-33/D2).
    const open =
      nested && (openSubagents[key] ?? (childrenGoing > 0 || background > 0));
    const all = allSubagents.has(key);
    const shownSubagents = all ? ordered : ordered.slice(0, SUBAGENTS_FOLDED);
    const isPinned = session.pinnedAt !== null;
    const current = isCurrent(session);
    const tab = runningFor(session);
    const chat = chatFor(session);
    const terminal = Boolean(tab) || chat;
    // Stop asks first while it works, as for a tab. A chat's Stop ends its
    // engine: the turn is cut off, the conversation kept.
    const stopChat = () =>
      void window.desktop?.conversation
        .close(workspace, session.id)
        .catch(() => {})
        .finally(() => void refreshChats(workspace));
    const onStop = tab
      ? () =>
          working
            ? setConfirming({
                stop: () => void stop(workspace, tab.id),
                label: agent,
              })
            : void stop(workspace, tab.id)
      : chat
        ? () =>
            working
              ? setConfirming({ stop: stopChat, label: agent })
              : stopChat()
        : undefined;
    const onResume = () => openSession(session);
    /** A sub-agent opens read-only, in the main view (FE-35/D9). */
    const view = (sub: AgentSubagent) =>
      void navigate({
        to: "/w/$slug/agents/sub/$conversation/$sub",
        params: { slug, conversation: session.id, sub: sub.id },
        search: { agent: session.agent },
      });
    const viewed = (sub: AgentSubagent) =>
      viewing === session.id &&
      viewingSub === sub.id &&
      (viewingAgent ?? "claude") === session.agent;
    // Known once its row was hovered, or its agent viewed (FE-38/D5).
    const summary = summaries[key] ?? null;
    return (
      <Fragment key={key}>
        <div className="group/row relative">
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  onClick={onResume}
                  aria-current={current ? "page" : undefined}
                  aria-label={`Open “${session.title}”`}
                  aria-busy={working || undefined}
                  title={`${session.title}\n${agent}, ${working ? "working" : terminal ? "running" : relativeTime(session.updatedAt, now)}${summary ? `\n${summary}` : ""}`}
                  onPointerEnter={() => peek(session)}
                  onPointerLeave={unpeek}
                  onFocus={() => peek(session)}
                  onBlur={unpeek}
                  className={`${row} w-full text-left ${current ? activeClass : ""} ${terminal ? "group-hover/row:pe-12 group-focus-within/row:pe-12" : "group-hover/row:pe-7 group-focus-within/row:pe-7"}`}
                />
              }
            >
              {/* With sub-agents, hover trades the icon for their chevron. */}
              <span className={`flex shrink-0 ${nested ? MAKES_ROOM : ""}`}>
                <TerminalKindIcon
                  kind={session.agent}
                  className="size-3 shrink-0"
                />
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${working ? "text-shimmer" : ""}`}
              >
                {session.title}
              </span>
              {/* The Pinned group says so itself; in Running the mark is where
              the row goes back to on Stop. */}
              {isPinned && !inPinned && (
                <HugeiconsIcon
                  icon={PinIcon}
                  className={`text-muted-foreground size-3 shrink-0 ${MAKES_ROOM}`}
                  strokeWidth={1.8}
                  aria-label="Pinned"
                />
              )}
              {/* How many it spawned; while some are going, how many are,
                beside a dot that stands for a spinner (FE-33/D7). */}
              {children > 0 && (
                <span
                  aria-hidden="true"
                  data-testid="subagent-count"
                  className={`text-muted-foreground flex shrink-0 items-center gap-1 text-xs tabular-nums ${MAKES_ROOM}`}
                >
                  {childrenGoing > 0 && (
                    <span className="bg-tone-emerald size-1.5 rounded-full" />
                  )}
                  {childrenGoing > 0 ? childrenGoing : children}
                </span>
              )}
              {/* A Codex goal that stopped short says so (FE-41/D4). */}
              <CodexGoalBadge
                workspace={workspace}
                session={session}
                className={MAKES_ROOM}
              />
              {working && (
                <span className={`flex shrink-0 ${MAKES_ROOM}`}>
                  <WorkingMark />
                </span>
              )}
              <span
                className={`text-muted-foreground shrink-0 text-xs tabular-nums ${MAKES_ROOM}`}
              >
                {shortAge(session.updatedAt, now)}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => setRenaming(session)}>
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => void pin(workspace, session, !isPinned)}
              >
                {isPinned ? "Unpin" : "Pin"}
              </ContextMenuItem>
              {/* Off while a tab runs it (FE-72/D5), as Delete is. */}
              <ContextMenuItem
                disabled={Boolean(onStop)}
                onClick={() =>
                  archive(workspace, session).then(
                    () => {
                      if (viewing === session.id)
                        void navigate({
                          to: "/w/$slug/issues",
                          params: { slug },
                        });
                    },
                    (error: unknown) =>
                      setArchiveError(
                        ipcMessage(error, "Could not archive it."),
                      ),
                  )
                }
              >
                Archive
              </ContextMenuItem>
              {onStop && <StopItem onStop={onStop} />}
              <ContextMenuSeparator />
              {/* NOTE: Off while a tab runs it (FE-57/D4): the CLI would only
                  write the transcript again. Stop first. */}
              <ContextMenuItem
                variant="destructive"
                disabled={Boolean(onStop)}
                onClick={() =>
                  setDeleting({ session, busy: false, error: null })
                }
              >
                Delete…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {/* NOTE: A sibling laid over the icon, like the quick actions:
            the row is a button, and a button cannot hold another. */}
          {nested && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${
                workers.length > 0
                  ? `${workers.length} worker${workers.length === 1 ? "" : "s"}`
                  : subagents.length > 0
                    ? `${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}`
                    : `${background} background task${background === 1 ? "" : "s"}`
              }`}
              title={[
                workers.length > 0 &&
                  `${workers.length} worker${workers.length === 1 ? "" : "s"}${workersGoing > 0 ? `, ${workersGoing} working` : ""}`,
                subagents.length > 0 &&
                  `${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}${going > 0 ? `, ${going} working` : ""}`,
                background > 0 && `${background} running in the background`,
              ]
                .filter(Boolean)
                .join("\n")}
              onClick={() => setOpenSubagents(session, !open)}
              className="text-muted-foreground hover:text-foreground pointer-events-none absolute inset-y-0 left-0 flex w-7 items-center justify-center opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100"
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                strokeWidth={2}
              />
            </button>
          )}
          <QuickActions
            onStop={onStop}
            pin={{
              pinned: isPinned,
              onToggle: () => void pin(workspace, session, !isPinned),
            }}
          />
        </div>
        {open && background > 0 && (
          <BackgroundShellRows
            workspace={workspace}
            slug={slug}
            session={session}
            row={row}
            active={activeClass}
            viewingTask={viewing === session.id ? viewingTask : undefined}
            now={now}
          />
        )}
        {open &&
          shownSubagents.map(({ sub, working: busy }) => (
            // Opens its transcript, read-only (FE-35/D9), not its
            // conversation: that is usually the one on screen already, so a
            // click would look like it did nothing. A sub-agent has nothing of
            // its own to resume; its conversation's row still resumes.
            <button
              key={sub.id}
              type="button"
              onClick={() => view(sub)}
              aria-current={viewed(sub) ? "page" : undefined}
              aria-busy={busy || undefined}
              aria-label={`${sub.title}, a sub-agent of “${session.title}”. Open its transcript`}
              title={`${sub.title}\n${sub.type ?? "Sub-agent"}, ${busy ? "working" : relativeTime(sub.updatedAt, now)}`}
              className={cn(row, SUB_ROW, viewed(sub) && activeClass)}
            >
              <TerminalKindIcon
                kind={session.agent}
                className="size-3 shrink-0 opacity-60"
              />
              <span
                className={`min-w-0 flex-1 truncate ${busy ? "text-shimmer" : viewed(sub) ? "" : "text-muted-foreground"}`}
              >
                {sub.title}
              </span>
              {busy && <WorkingMark />}
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {shortAge(sub.updatedAt, now)}
              </span>
            </button>
          ))}
        {open &&
          workers.map((task) => {
            const busy =
              task.status === "running" || task.status === "cancelling";
            const seen =
              task.conversation !== null &&
              viewing === task.conversation &&
              !viewingSub &&
              !viewingTask;
            return (
              // A worker opens its own conversation, read-only: the lead is
              // the one that talks to it. Not started yet, it has none.
              <button
                key={`worker:${task.id}`}
                type="button"
                disabled={task.conversation === null}
                onClick={() => {
                  if (task.conversation)
                    void navigate({
                      to: "/w/$slug/agents/chat/$conversation",
                      params: { slug, conversation: task.conversation },
                    });
                }}
                aria-current={seen ? "page" : undefined}
                aria-busy={busy || undefined}
                aria-label={`${task.title}, a worker of “${session.title}”: ${workerLabel(task)}`}
                title={`${task.title}\n${TERMINAL_KIND_LABELS[task.agent]} worker, ${workerLabel(task).toLowerCase()}`}
                className={cn(row, SUB_ROW, seen && activeClass)}
              >
                <TerminalKindIcon
                  kind={task.agent}
                  className="size-3 shrink-0 opacity-60"
                />
                <span
                  className={`min-w-0 flex-1 truncate ${busy ? "text-shimmer" : seen ? "" : "text-muted-foreground"}`}
                >
                  {task.title}
                </span>
                {busy ? (
                  <WorkingMark />
                ) : (
                  <span className={cn("shrink-0", workerTone(task))}>
                    {workerLabel(task)}
                  </span>
                )}
              </button>
            );
          })}
        {open && ordered.length > SUBAGENTS_FOLDED && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() =>
              setAllSubagents((keys) => {
                const next = new Set(keys);
                if (all) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            className={cn(row, SUB_ROW, "text-muted-foreground")}
          >
            {all
              ? "Show less"
              : `Show ${ordered.length - SUBAGENTS_FOLDED} more`}
          </button>
        )}
      </Fragment>
    );
  };

  return (
    // One provider for the rail's quick actions. Base UI's own 600ms is longer
    // than a pointer rests on a 20px icon, so the tip would never show; and
    // once one is open, the next (Stop → Pin) opens without waiting.
    <TooltipProvider delay={50}>
      {pinned.length > 0 && (
        <nav aria-label="Pinned" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Pinned
            </span>
          </div>
          {pinned.map((session) => sessionRow(session, true))}
        </nav>
      )}
      {/* The agents running right now (their pty is alive), whether or not
          they are mid-turn: the ones with Stop. Hidden when none is. */}
      {hasRunning && (
        <nav aria-label="Running" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Running
            </span>
          </div>
          {pending.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-current={entry.current ? "page" : undefined}
              aria-label={`Open “${entry.label}”`}
              aria-busy={entry.working || undefined}
              title={`${entry.label}\n${TERMINAL_KIND_LABELS[entry.agent]}, ${entry.working ? "starting" : "new"}`}
              onClick={entry.open}
              className={`${row} w-full text-left ${entry.current ? activeClass : ""}`}
            >
              <TerminalKindIcon
                kind={entry.agent}
                className="size-3 shrink-0"
              />
              <span
                className={`min-w-0 flex-1 truncate ${entry.working ? "text-shimmer" : "text-muted-foreground"}`}
              >
                {entry.label}
              </span>
              {entry.working && <WorkingMark />}
            </button>
          ))}
          {fresh.map((entry) => {
            const agent = TERMINAL_KIND_LABELS[entry.kind];
            const current = entry.id === terminalId;
            return (
              <div key={entry.id} className="group/row relative">
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-current={current ? "page" : undefined}
                        aria-label={`Open new ${agent} session`}
                        onClick={() => go(entry)}
                        className={`${row} w-full text-left ${current ? activeClass : ""} group-hover/row:pe-7 group-focus-within/row:pe-7`}
                      />
                    }
                  >
                    <TerminalKindIcon
                      kind={entry.kind}
                      className="size-3 shrink-0"
                    />
                    <span className="text-muted-foreground min-w-0 flex-1 truncate">
                      New {agent} session
                    </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <StopItem onStop={() => void stop(workspace, entry.id)} />
                  </ContextMenuContent>
                </ContextMenu>
                <QuickActions onStop={() => void stop(workspace, entry.id)} />
              </div>
            );
          })}
          {inRunning.map((session) => sessionRow(session))}
        </nav>
      )}
      {(idle.length > 0 || hasFolder) && (
        <nav aria-label="Agents" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Agents
            </span>
            <span className="flex items-center gap-0.5">
              {/* Every conversation by title, past the fold: Claude Code's
                and Codex's in one list. */}
              <button
                type="button"
                aria-label="Search conversations"
                title="Search conversations"
                disabled={sessions.length === 0}
                onClick={() => setSearching(true)}
                className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={Search01Icon}
                  className="size-3.5"
                  strokeWidth={2}
                />
              </button>
              {/* A new conversation opens as a chat: its model picks the CLI,
                Claude Code or Codex, and its composer starts it. */}
              <button
                type="button"
                aria-label="New conversation"
                title="New conversation"
                disabled={!hasFolder}
                onClick={() =>
                  void navigate({
                    to: "/w/$slug/agents/chat/new",
                    params: { slug },
                  })
                }
                className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  className="size-3.5"
                  strokeWidth={2}
                />
              </button>
            </span>
          </div>
          {shown.map((session) => sessionRow(session))}
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
        </nav>
      )}
      <AgentSessionSearch
        open={searching}
        onOpenChange={setSearching}
        sessions={sessions}
        onPick={openSession}
      />
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {confirming?.label} while it is working?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Whatever it is doing now is interrupted. The conversation is kept
              and can be resumed from the Agents group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirming?.stop();
                setConfirming(null);
              }}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !deleting?.busy && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting?.session.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its transcript is deleted from this machine for good. There is no
              undo, and{" "}
              {deleting?.session.agent === "codex"
                ? "codex resume"
                : "claude --resume"}{" "}
              will no longer find it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting?.error && (
            <p role="alert" className="text-destructive text-[13px]">
              {deleting.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting?.busy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting?.busy}
              onClick={(event) => {
                // NOTE: Kept open until main answers, so a refusal is shown
                // here, not lost with a dialog that already closed.
                event.preventDefault();
                if (!deleting) return;
                const { session } = deleting;
                setDeleting({ session, busy: true, error: null });
                remove(workspace, session).then(
                  () => {
                    setDeleting(null);
                    if (viewing === session.id)
                      void navigate({
                        to: "/w/$slug/issues",
                        params: { slug },
                      });
                  },
                  (error: unknown) =>
                    setDeleting({
                      session,
                      busy: false,
                      error: ipcMessage(error, "Could not delete it."),
                    }),
                );
              }}
            >
              {deleting?.busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={archiveError !== null}
        onOpenChange={(open) => !open && setArchiveError(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Could not archive it</AlertDialogTitle>
            <AlertDialogDescription>{archiveError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>OK</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameAgentDialog
        workspace={workspace}
        session={renaming}
        onClose={() => setRenaming(null)}
      />
    </TooltipProvider>
  );
}
