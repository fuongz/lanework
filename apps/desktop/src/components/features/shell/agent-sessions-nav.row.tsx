import { ArrowRight01Icon, PinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
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
import { StatusPing } from "#/components/shared/agents/status-ping";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { useOpenInTerminal } from "#/hooks/use-open-in-terminal";
import { ipcMessage } from "#/lib/ipc-error";
import {
  taskLabel as workerLabel,
  taskTone as workerTone,
} from "#/lib/orchestration-status";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";
import { useAgentFacts } from "#/stores/agent-facts";
import {
  agentKey,
  subagentKey,
  useAgentSessions,
} from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { awaitingKey, useAwaiting } from "#/stores/awaiting";
import { useChatEngines } from "#/stores/chat-engines";
import { CodexGoalBadge } from "./codex-goal-badge";

const NO_TASKS: OrchestrationTask[] = [];
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
 * A conversation's background shells and monitors still running, as rows
 * under it beside its sub-agents' (FE-42/D1).
 *
 * Its background agents are already sub-agent rows. A row opens the task's
 * own page. Mounted only for a conversation whose listing counts one running,
 * so the rail reads no task list for the rest.
 */
function BackgroundShellRows({
  project,
  slug,
  session,
  row,
  active,
  viewingTask,
  now,
}: {
  project: string;
  slug: string;
  session: AgentSession;
  row: string;
  active: string;
  /** The task whose page is on screen, if one is. */
  viewingTask: string | undefined;
  now: number;
}) {
  const navigate = useNavigate();
  const stopping = useStopBackgroundTask(project, session.id);
  const { tasks } = useBackgroundTasks(
    project,
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
              {/* Its kind on the left, so a row says what runs; the ping
              under it, as a session's, says it still does. */}
              <span className="relative flex shrink-0">
                <HugeiconsIcon
                  icon={TASK_KIND_ICONS[task.kind]}
                  className="text-muted-foreground size-3 shrink-0"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <StatusPing tone="working" />
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${viewed ? "" : "text-muted-foreground"}`}
              >
                {name}
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

/**
 * A conversation waiting on the person (FE-97/D4a): a primary dot in its
 * agent icon's slot, with a ring that keeps expanding until it is answered.
 *
 * Reduced motion drops the ring and keeps the dot.
 */
export function AwaitingDot({ className = "size-3" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="awaiting-dot"
      className={cn("relative grid shrink-0 place-items-center", className)}
    >
      <span className="bg-primary absolute size-2 animate-ping rounded-full opacity-75 motion-reduce:hidden motion-reduce:animate-none" />
      <span className="bg-primary relative size-2 rounded-full" />
    </span>
  );
}

/** What hover hides to make room for the sub-agents' chevron. */
const MAKES_ROOM = "group-hover/row:invisible group-focus-within/row:invisible";

/** A running agent's Stop, in its row's context menu. */
export function StopItem({ onStop }: { onStop: () => void }) {
  return (
    <ContextMenuItem variant="destructive" onClick={onStop}>
      Stop
    </ContextMenuItem>
  );
}

/**
 * One conversation's row in the full rail, with what nests under it: its
 * background shells, sub-agents and orchestration workers (FE-33, FE-42,
 * FE-87).
 *
 * A component, not a closure, so a row reads its own slices of the stores
 * (its facts line, its open state) and redraws when they change.
 */
export function SessionRow({
  project,
  slug,
  session,
  running,
  row,
  active: activeClass,
  now,
  working,
  current,
  tab,
  chat,
  workers = NO_TASKS,
  allShown: all,
  onToggleAll,
  onResume,
  onRename,
  onArchiveError,
  onDelete,
  onConfirmStop,
}: {
  project: string;
  slug: string;
  session: AgentSession;
  /** Its agent is running (a tab, the chat's engine, or a run it leads). */
  running: boolean;
  /** The rail's row classes. */
  row: string;
  /** The rail's active-row classes. */
  active: string;
  now: number;
  /** Thinking or working: a turn open in its transcript. */
  working: boolean;
  /** Its terminal or chat is on screen. */
  current: boolean;
  /** The live terminal resuming it, if one is. */
  tab: TerminalSession | undefined;
  /** The chat's own engine is running it. */
  chat: boolean;
  /** Its orchestration run's workers, in the run's order (FE-87). */
  workers?: OrchestrationTask[];
  /** Every sub-agent shown, past the fold (FE-33/D4). */
  allShown: boolean;
  onToggleAll: () => void;
  onResume: () => void;
  onRename: () => void;
  /** Why an Archive was refused. */
  onArchiveError: (message: string) => void;
  onDelete: () => void;
  /** A working agent's Stop asks first (FE-26/D5). */
  onConfirmStop: (confirm: { stop: () => void; label: string }) => void;
}) {
  const navigate = useNavigate();
  const {
    conversation: viewing,
    sub: viewingSub,
    task: viewingTask,
  } = useParams({ strict: false }) as {
    conversation?: string;
    sub?: string;
    task?: string;
  };
  // The sub-agent viewer's: which CLI's conversation `viewing` is.
  const { agent: viewingAgent } = useSearch({ strict: false });
  const key = agentKey(session);
  const live = useAgentSessions((state) => state.live);
  const openState = useAgentSessions((state) => state.open[key]);
  const setOpenSubagents = useAgentSessions((state) => state.setOpen);
  const pin = useAgentSessions((state) => state.pin);
  const archive = useAgentSessions((state) => state.archive);
  const stop = useAgentTerminals((state) => state.stop);
  const refreshChats = useChatEngines((state) => state.refresh);
  const openInTerminal = useOpenInTerminal(slug, project);
  // Known once its row was hovered, or its agent viewed (FE-38/D5). The
  // tooltip line, not the facts: a view open on an agent reads its facts on
  // every write, and the row redraws only when the line changes.
  const summary = useAgentFacts((state) => {
    const entry = state.byKey[key];
    return entry ? factsSummary(entry.facts) : null;
  });
  const readFacts = useAgentFacts((state) => state.read);
  // Its agent stopped on a question or a permission (FE-97).
  const awaiting = useAwaiting(
    (state) => awaitingKey(project, session.id) in state.byKey,
  );
  const peeking = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (peeking.current) clearTimeout(peeking.current);
    },
    [],
  );
  /**
   * Read the row's cost and context, for its tooltip (FE-38/D5).
   *
   * Only once a pointer rests on the row: never for the whole list, and not
   * for one it merely passes over on its way down the rail.
   */
  const peek = () => {
    if (peeking.current) clearTimeout(peeking.current);
    peeking.current = setTimeout(() => {
      const known = useAgentFacts.getState().byKey[key];
      if (!known || Date.now() - known.at > FACTS_FRESH_MS)
        readFacts(project, session);
    }, PEEK_MS);
  };
  const unpeek = () => {
    if (peeking.current) clearTimeout(peeking.current);
    peeking.current = null;
  };

  const agent = TERMINAL_KIND_LABELS[session.agent];
  const subagents = session.subagents;
  // Working first, then newest (FE-33/D4): the ones still going are the
  // ones worth seeing above the fold.
  const ordered = subagents
    .map((sub) => ({
      sub,
      working: live[subagentKey(session, sub)] ?? sub.working,
    }))
    .sort(
      (a, b) =>
        Number(b.working) - Number(a.working) ||
        b.sub.updatedAt.localeCompare(a.sub.updatedAt),
    );
  const going = ordered.filter((entry) => entry.working).length;
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
  const open = nested && (openState ?? (childrenGoing > 0 || background > 0));
  const shownSubagents = all ? ordered : ordered.slice(0, SUBAGENTS_FOLDED);
  const isPinned = session.pinnedAt !== null;
  const terminal = Boolean(tab) || chat;
  // Stop asks first while it works, as for a tab. A chat's Stop ends its
  // engine: the turn is cut off, the conversation kept.
  const stopChat = () =>
    void window.desktop?.conversation
      .close(project, session.id)
      .catch(() => {})
      .finally(() => void refreshChats(project));
  const onStop = tab
    ? () =>
        working
          ? onConfirmStop({
              stop: () => void stop(project, tab.id),
              label: agent,
            })
          : void stop(project, tab.id)
    : chat
      ? () =>
          working ? onConfirmStop({ stop: stopChat, label: agent }) : stopChat()
      : undefined;
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
  return (
    <>
      <div className="group/row relative">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <button
                type="button"
                onClick={onResume}
                aria-current={current ? "page" : undefined}
                aria-label={`Open “${session.title}”${awaiting ? ", waiting for you" : ""}`}
                aria-busy={working || undefined}
                title={`${session.title}\n${agent}, ${awaiting ? "waiting for you" : working ? "working" : terminal ? "running" : relativeTime(session.updatedAt, now)}${summary ? `\n${summary}` : ""}`}
                onPointerEnter={peek}
                onPointerLeave={unpeek}
                onFocus={peek}
                onBlur={unpeek}
                className={`${row} w-full text-left ${current ? activeClass : ""}`}
              />
            }
          >
            {/* With sub-agents, hover trades the icon for their chevron. */}
            <span
              className={`relative flex shrink-0 ${nested ? MAKES_ROOM : ""}`}
            >
              <TerminalKindIcon
                kind={session.agent}
                className="size-3 shrink-0"
              />
              {(awaiting || working || running) && (
                <StatusPing
                  tone={awaiting ? "awaiting" : working ? "working" : "running"}
                />
              )}
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${working ? "text-shimmer" : ""}`}
            >
              {session.title}
            </span>
            {/* Pinned rows lead Sessions; the mark says why this one is up. */}
            {isPinned && (
              <HugeiconsIcon
                icon={PinIcon}
                className="text-muted-foreground size-3 shrink-0"
                strokeWidth={1.8}
                aria-label="Pinned"
              />
            )}
            {/* A Codex goal that stopped short says so (FE-41/D4). */}
            <CodexGoalBadge project={project} session={session} />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
            <ContextMenuItem
              onClick={() => void pin(project, session, !isPinned)}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            {/* Off while a tab runs it (FE-72/D5), as Delete is. OpenCode
                keeps no archive (FE-104/D11). */}
            {session.agent !== "opencode" && (
              <ContextMenuItem
                disabled={Boolean(onStop)}
                onClick={() =>
                  archive(project, session).then(
                    () => {
                      if (viewing === session.id)
                        void navigate({
                          to: "/w/$slug/issues",
                          params: { slug },
                        });
                    },
                    (error: unknown) =>
                      onArchiveError(
                        ipcMessage(error, "Could not archive it."),
                      ),
                  )
                }
              >
                Archive
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            {/* The chat's Terminal button, moved here: the same
                conversation in a terminal, not while a turn runs (D3). */}
            <ContextMenuItem
              disabled={working && !tab}
              onClick={() =>
                void openInTerminal(session).then(
                  (error) => error && onArchiveError(error),
                )
              }
            >
              {tab ? "Show terminal" : "Open in terminal"}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {onStop && <StopItem onStop={onStop} />}
            {/* NOTE: Off while a tab runs it (FE-57/D4): the CLI would only
                write the transcript again. Stop first. Main deletes
                OpenCode's through its own CLI (FE-104). */}
            <ContextMenuItem
              variant="destructive"
              disabled={Boolean(onStop)}
              onClick={onDelete}
            >
              Delete…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* NOTE: A sibling laid over the icon: the row is a button, and a
          button cannot hold another. */}
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
      </div>
      {open && background > 0 && (
        <BackgroundShellRows
          project={project}
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
            <span className="relative flex shrink-0">
              <TerminalKindIcon
                kind={session.agent}
                className="size-3 shrink-0 opacity-60"
              />
              {busy && <StatusPing tone="working" />}
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${busy ? "text-shimmer" : viewed(sub) ? "" : "text-muted-foreground"}`}
            >
              {sub.title}
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
              <span className="relative flex shrink-0">
                <TerminalKindIcon
                  kind={task.agent}
                  className="size-3 shrink-0 opacity-60"
                />
                {busy && <StatusPing tone="working" />}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${busy ? "text-shimmer" : seen ? "" : "text-muted-foreground"}`}
              >
                {task.title}
              </span>
              {!busy && (
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
          onClick={onToggleAll}
          className={cn(row, SUB_ROW, "text-muted-foreground")}
        >
          {all ? "Show less" : `Show ${ordered.length - SUBAGENTS_FOLDED} more`}
        </button>
      )}
    </>
  );
}
