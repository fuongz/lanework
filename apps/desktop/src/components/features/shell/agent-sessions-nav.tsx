import {
  Add01Icon,
  ArrowRight01Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentSession,
  AgentSubagent,
  TerminalSession,
} from "#/../shared/terminal";
import {
  backgroundCue,
  TASK_KIND_ICONS,
} from "#/components/shared/agents/background-tasks";
import { CodexGoalBadge } from "#/components/shared/agents/codex-usage";
import { factsSummary } from "#/components/shared/agents/conversation-facts";
import { useBackgroundTasks } from "#/components/shared/agents/use-background-tasks";
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
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { relativeTime, shortAge } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import { useAgentFacts } from "#/stores/agent-facts";
import {
  agentKey,
  subagentKey,
  useAgentSessions,
} from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useTerminal } from "#/stores/terminal";
import { RenameAgentDialog } from "./rename-agent-dialog";

/** Stable empty lists: a selector that allocated one would re-render forever. */
const NONE: AgentSession[] = [];
const NO_TERMINALS: TerminalSession[] = [];
/** Rows before "Show more" (FE-23/D4); the rest, up to the listing's 20, after. */
const FOLDED = 5;
/** A conversation's sub-agent rows before its own "Show more" (FE-33/D4). */
const SUBAGENTS_FOLDED = 3;
/**
 * A sub-agent row: shorter than a conversation's, and indented so its icon
 * sits under its conversation's title (`px-2` + the 12px icon + `gap-2.5`).
 */
const SUB_ROW = "h-[26px] w-full ps-[30px] text-left text-xs";
/** A pointer resting this long on a row means it: its numbers are read (FE-38/D5). */
const PEEK_MS = 150;
/** A row's numbers read this recently are shown again, not read again. */
const FACTS_FRESH_MS = 15_000;

/**
 * A row's quick actions, shown on hover or keyboard focus in place of its age
 * — Stop for a running agent, then Pin, rightmost like the rail's others.
 *
 * ⚠️ SIBLINGS laid over the row, not inside it: the row is a button, and a
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
 * A conversation's background shells and monitors still running (FE-42/D1),
 * as rows under it beside its sub-agents' — its background agents already
 * are sub-agent rows. A row opens the task's own page.
 *
 * ⚠️ Mounted only for a conversation whose listing counts one running, so
 * the rail reads no task list for the rest.
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
  const { tasks } = useBackgroundTasks(
    workspace,
    session.id,
    backgroundCue(session),
  );
  const shells = (tasks ?? []).filter(
    (task) => task.status === "running" && task.kind !== "agent",
  );
  return shells.map((task) => {
    const viewed = viewingTask === task.id;
    const name = task.description || task.command || task.id;
    return (
      <button
        key={task.id}
        type="button"
        onClick={() =>
          void navigate({
            to: "/w/$slug/agents/task/$conversation/$task",
            params: { slug, conversation: session.id, task: task.id },
          })
        }
        aria-current={viewed ? "page" : undefined}
        aria-label={`${name}, a background ${task.kind} of “${session.title}”. Open its output`}
        title={`${task.command ?? name}\nBackground ${task.kind}, running since ${relativeTime(task.startedAt, now)}`}
        className={cn(row, SUB_ROW, viewed && active)}
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
      </button>
    );
  });
}

/** What hover hides to make room for the quick actions. */
const MAKES_ROOM = "group-hover/row:invisible group-focus-within/row:invisible";

/** A running agent's Stop, in its row's context menu. */
function StopItem({ onStop }: { onStop: () => void }) {
  return (
    <ContextMenuItem
      variant="destructive"
      className="text-[13px]"
      onClick={onStop}
    >
      <HugeiconsIcon icon={StopIcon} strokeWidth={1.8} />
      Stop
    </ContextMenuItem>
  );
}

/**
 * The rail's Agents group (FE-23): the Claude and Codex conversations this
 * project's folder has, newest first. A row opens its agent full size in the
 * main view — the one already resuming it, or a new one (FE-26).
 *
 * ⚠️ The rail IS the agents' tab list (FE-26/D1): the row whose agent is on
 * screen is marked the way an active link is, and a new conversation that
 * has not written a transcript yet still has a row, so it can be got back to.
 *
 * ⚠️ Three groups, and a row is in exactly ONE: Running holds the agents
 * whose pty is alive, Stop in each one's context menu; Pinned the pinned
 * transcripts; Agents the rest. Running wins over Pinned — a pinned
 * conversation that is resumed moves up to Running, and comes back on Stop.
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
  // The sub-agent viewer's (FE-35): which CLI's conversation `viewing` is.
  const { agent: viewingAgent } = useSearch({ strict: false }) as {
    agent?: string;
  };
  const onScreen = running.find((entry) => entry.id === terminalId);
  const live = useAgentSessions((state) => state.live);
  const watchActivity = useAgentSessions((state) => state.watchActivity);
  const pin = useAgentSessions((state) => state.pin);
  const openSubagents = useAgentSessions((state) => state.open);
  const setOpenSubagents = useAgentSessions((state) => state.setOpen);
  const [expanded, setExpanded] = useState(false);
  /** Conversations whose sub-agents are all shown, past the fold (FE-33/D4). */
  const [allSubagents, setAllSubagents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [renaming, setRenaming] = useState<AgentSession | null>(null);
  // ⚠️ The tooltip lines, not the facts: a view open on an agent reads its
  // facts on every write, and the rail redraws only when a line changes.
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
   * A row's cost and context, for its tooltip (FE-38/D5).
   *
   * ⚠️ Read only once a pointer rests on that row — never for the whole
   * list, and not for one it merely passes over on its way down the rail.
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
    terminal: TerminalSession;
    label: string;
  } | null>(null);

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

  if (agents.length === 0) return null;

  // ⚠️ A conversation is in ONE group: Running while its agent is, Agents
  // once it is only a transcript again — never both, so the rail marks one
  // row as on screen.
  const inRunning = sessions.filter((session) => runningFor(session));
  const idle = sessions.filter((session) => !runningFor(session));
  const hasRunning = fresh.length > 0 || inRunning.length > 0;
  if (!hasRunning && idle.length === 0 && !hasFolder) return null;

  const go = (next: TerminalSession | null) => {
    if (next)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: next.id },
      });
  };

  // ⚠️ Pinned is its own group, newest pin on top, and ALWAYS shown in full
  // — the fold only ever hides Agents' rows (FE-25/D1).
  const pinned = idle
    .filter((session) => session.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const rest = idle.filter((session) => session.pinnedAt === null);
  const shown = expanded ? rest : rest.slice(0, FOLDED);

  const sessionRow = (session: AgentSession, inPinned = false) => {
    const agent = TERMINAL_KIND_LABELS[session.agent];
    const working = isWorking(session);
    const key = agentKey(session);
    const subagents = session.subagents;
    // ⚠️ Working first, then newest (FE-33/D4): the ones still going are
    // the ones worth seeing above the fold.
    const ordered = subagents
      .map((sub) => ({ sub, working: subagentWorking(session, sub) }))
      .sort(
        (a, b) =>
          Number(b.working) - Number(a.working) ||
          b.sub.updatedAt.localeCompare(a.sub.updatedAt),
      );
    const going = ordered.filter((entry) => entry.working).length;
    // Its background tasks still running (FE-42/D1): Claude counts them.
    const background =
      session.agent === "claude" ? session.background.running : 0;
    const nested = subagents.length > 0 || background > 0;
    // Unset follows them: open while one is going (FE-33/D2).
    const open =
      nested && (openSubagents[key] ?? (going > 0 || background > 0));
    const all = allSubagents.has(key);
    const shownSubagents = all ? ordered : ordered.slice(0, SUBAGENTS_FOLDED);
    const isPinned = session.pinnedAt !== null;
    const current =
      onScreen?.resume === session.id && onScreen.kind === session.agent;
    const terminal = runningFor(session);
    const onStop = terminal
      ? () =>
          working
            ? setConfirming({ terminal, label: agent })
            : void stop(workspace, terminal.id)
      : undefined;
    const onResume = () => void resume(workspace, session).then(go);
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
                  aria-label={`Resume “${session.title}” in ${agent}`}
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
              {/* Pinned says so itself; in Running the mark is where the row goes
              back to on Stop. */}
              {isPinned && !inPinned && (
                <HugeiconsIcon
                  icon={PinIcon}
                  className={`text-muted-foreground size-3 shrink-0 ${MAKES_ROOM}`}
                  strokeWidth={1.8}
                  aria-label="Pinned"
                />
              )}
              {/* How many it spawned; while some are going, how many are, by
                the dot a still spinner is (FE-33/D7). */}
              {subagents.length > 0 && (
                <span
                  aria-hidden="true"
                  data-testid="subagent-count"
                  className={`text-muted-foreground flex shrink-0 items-center gap-1 text-xs tabular-nums ${MAKES_ROOM}`}
                >
                  {going > 0 && (
                    <span className="bg-tone-emerald size-1.5 rounded-full" />
                  )}
                  {going > 0 ? going : subagents.length}
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
              {onStop && <StopItem onStop={onStop} />}
            </ContextMenuContent>
          </ContextMenu>
          {/* ⚠️ A sibling laid over the icon, like the quick actions: the
            row is a button, and a button cannot hold another. */}
          {nested && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${
                subagents.length > 0
                  ? `${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}`
                  : `${background} background task${background === 1 ? "" : "s"}`
              }`}
              title={`${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}${going > 0 ? `, ${going} working` : ""}${background > 0 ? `\n${background} running in the background` : ""}`}
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
            // ⚠️ Opens its transcript, read-only (FE-35/D9) — not its
            // conversation, which was usually the one on screen already, so
            // a click looked like it did nothing. A sub-agent has nothing of
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
    // ⚠️ One provider for the rail's quick actions: Base UI's own 600ms is
    // longer than a pointer rests on a 20px icon, so the tip never showed;
    // and once one is open, the next (Stop → Pin) opens without waiting.
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
          they are mid-turn — the ones with Stop. Hidden when none is. */}
      {hasRunning && (
        <nav aria-label="Running" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Running
            </span>
          </div>
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
                    <TerminalKindIcon
                      kind={agent}
                      className="size-4 shrink-0"
                    />
                    New {TERMINAL_KIND_LABELS[agent]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
                if (confirming) void stop(workspace, confirming.terminal.id);
                setConfirming(null);
              }}
            >
              Stop
            </AlertDialogAction>
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
