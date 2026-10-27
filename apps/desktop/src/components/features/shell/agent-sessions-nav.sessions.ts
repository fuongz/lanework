import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import type { AgentSession, TerminalSession } from "#/../shared/terminal";
import { useChatAgent } from "#/components/shared/conversation/chat-agent";
import { liveRun, useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { NO_CHATS, useChatEngines } from "#/stores/chat-engines";
import { type NewChat, useNewChats } from "#/stores/new-chats";
import { useTerminal } from "#/stores/terminal";

/** Stable empty lists: a selector that allocates one re-renders forever. */
const NONE: AgentSession[] = [];
const NO_TERMINALS: TerminalSession[] = [];

/**
 * A conversation from the new-conversation page with no listed row yet: the
 * page itself, or one it started whose transcript is not listed.
 */
export interface PendingChat {
  key: string;
  agent: NewChat["agent"];
  label: string;
  working: boolean;
  current: boolean;
  open: () => void;
}

/**
 * What the rail's Agents groups list, and how a row opens: the conversations,
 * the agents running them, and which one is on screen.
 *
 * Owns the reads and their refresh policy: on entering the project, on focus,
 * when its terminals change, and as a started conversation's first turn
 * lands. Never on a timer, the Changes badge's rule.
 *
 * `visible` is false when there is nothing here to do: no agent CLI on this
 * machine, or no folder and no conversation (FE-23/D9).
 */
export function useAgentRail(
  workspace: string,
  slug: string,
  hasFolder: boolean,
) {
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
  const onScreen = running.find((entry) => entry.id === terminalId);
  const live = useAgentSessions((state) => state.live);
  const watchActivity = useAgentSessions((state) => state.watchActivity);
  // The new-conversation page, and what it started that is not listed yet.
  const onNewPage = useRouterState({
    select: (state) => state.location.pathname === `/w/${slug}/agents/chat/new`,
  });
  const chatAgent = useChatAgent();
  const starting = useNewChats((state) => state.starting[workspace]);
  const started = useNewChats((state) => state.started);
  const forgetStarted = useNewChats((state) => state.forget);

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
  const pending: PendingChat[] = [];
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

  // A conversation is in one group: Running while its agent is, Agents once
  // it is only a transcript again. Never both, so the rail marks one row as
  // on screen.
  const inRunning = sessions.filter(isRunning);
  const idle = sessions.filter((session) => !isRunning(session));
  const hasRunning =
    pending.length > 0 || fresh.length > 0 || inRunning.length > 0;
  const visible =
    agents.length > 0 && (hasRunning || idle.length > 0 || hasFolder);

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

  return {
    visible,
    sessions,
    pending,
    fresh,
    inRunning,
    idle,
    pinned,
    rest,
    hasRunning,
    now,
    terminalId,
    viewing,
    isWorking,
    isRunning,
    isCurrent,
    runningFor,
    chatFor,
    runFor,
    openSession,
    go,
  };
}
