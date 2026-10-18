import {
  Loading03Icon,
  MessageMultiple01Icon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type {
  AgentSession,
  TerminalAgent,
  TerminalSession,
} from "#/../shared/terminal";
import { BackgroundTasksButton } from "#/components/shared/agents/background-tasks";
import {
  ConversationFacts,
  ConversationRecap,
  ModelButton,
} from "#/components/shared/agents/conversation-facts";
import type { Fact } from "#/components/shared/agents/facts";
import { useConversationFacts } from "#/components/shared/agents/use-agent-facts";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { XtermPane } from "#/components/shared/terminal/xterm-pane";
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
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { AgentFilesButton } from "./agent-files";
import { goalFacts } from "./codex-goal";

/** Stable empties: a selector that allocated one would re-render forever. */
const NO_TERMINALS: TerminalSession[] = [];
const NO_CONVERSATIONS: AgentSession[] = [];
const NO_FACTS: Fact[] = [];

/**
 * One agent, full size in the main view (FE-26).
 *
 * ⚠️ The pty belongs to the HOST, not to this view: leaving the route
 * detaches and the agent keeps going (FE-26/D5); coming back attaches again
 * and the host's snapshot redraws the screen as it is. Only Stop ends it.
 */
export function AgentView() {
  const { slug, terminalId } = useParams({
    from: "/_app/w/$slug/agents/$terminalId",
  });
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const sessions = useAgentTerminals((state) =>
    workspace ? (state.sessions[workspace] ?? NO_TERMINALS) : NO_TERMINALS,
  );
  const refresh = useAgentTerminals((state) => state.refresh);
  const resume = useAgentTerminals((state) => state.resume);
  const start = useAgentTerminals((state) => state.start);
  const stop = useAgentTerminals((state) => state.stop);
  const markExited = useAgentTerminals((state) => state.markExited);
  const error = useAgentTerminals((state) => state.error);
  const conversations = useAgentSessions((state) =>
    workspace
      ? (state.byWorkspace[workspace] ?? NO_CONVERSATIONS)
      : NO_CONVERSATIONS,
  );
  const live = useAgentSessions((state) => state.live);
  const [listed, setListed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** The terminal id whose CLI has drawn something; until then, a spinner. */
  const [drawn, setDrawn] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setListed(false);
    void refresh(workspace).then(() => setListed(true));
  }, [refresh, workspace]);

  const session = sessions.find((entry) => entry.id === terminalId);

  // ⚠️ The agent on screen went away — `/exit`, ⌃C⌃C (FE-26): the view goes
  // with it, back to the board, rather than showing an agent that is over.
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (session) setSeen(session.id);
    else if (seen === terminalId)
      void navigate({ to: "/w/$slug/issues", params: { slug }, search: {} });
  }, [session, seen, terminalId, navigate, slug]);
  const agent = session?.kind === "shell" ? null : (session?.kind ?? null);
  const conversation = session?.resume
    ? conversations.find(
        (entry) => entry.id === session.resume && entry.agent === agent,
      )
    : undefined;
  // Thinking or working: a turn open in its transcript (FE-25).
  const working =
    !!conversation &&
    !session?.exit &&
    (live[agentKey(conversation)] ?? conversation.working);
  // ⚠️ By the tab's own conversation, listed or not: a new one has numbers
  // from its first answer, before the rail has its title (FE-38).
  const goal = useAgentSessions((state) =>
    workspace && conversation?.agent === "codex"
      ? state.codexGoals[workspace]?.[conversation.id]
      : undefined,
  );
  const facts = useConversationFacts(workspace, agent, session?.resume ?? null);

  const open = (next: TerminalSession | null) => {
    if (next)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: next.id },
      });
  };

  const [toChat, setToChat] = useState(false);
  /** Stop this tab, then open its conversation as a chat (FE-62/D3). */
  const openChat = async () => {
    const id = session?.resume;
    if (!workspace || !id || toChat || working) return;
    setToChat(true);
    try {
      if (!session?.exit)
        await window.desktop?.conversation.takeOver(workspace, id);
      void navigate({
        to: "/w/$slug/agents/chat/$conversation",
        params: { slug, conversation: id },
      });
    } catch {
      // Still running here: the tab stays, and so does the view.
    } finally {
      setToChat(false);
    }
  };

  const again = async (kind: TerminalAgent) => {
    if (!workspace) return;
    open(
      conversation
        ? await resume(workspace, conversation)
        : await start(workspace, kind),
    );
  };

  const end = async () => {
    if (!workspace || !session) return;
    setConfirming(false);
    await stop(workspace, session.id);
    void navigate({ to: "/w/$slug/issues", params: { slug }, search: {} });
  };

  if (!session || !agent) {
    if (!listed) return null;
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={StopIcon} strokeWidth={1.8} />
            </EmptyMedia>
            <EmptyTitle>This agent is not running</EmptyTitle>
            <EmptyDescription>
              It was stopped, or the app was restarted. Pick its conversation in
              the Agents group to resume it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const label = TERMINAL_KIND_LABELS[agent];
  const title = conversation?.title ?? `New ${label} session`;

  return (
    <section
      aria-label={`${label} — ${title}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* ⚠️ The header is the window's title bar now (FE-58), as Codex has
          it: the bar drags the window and clears its controls, so the row
          keeps only its content, in its order. */}
      <WindowTitlebar className="gap-2.5">
        {working ? (
          <span role="img" aria-label="Working" className="flex shrink-0">
            <OrbitSpinner className="text-foreground size-[13px]" />
          </span>
        ) : (
          <TerminalKindIcon kind={agent} className="size-[13px] shrink-0" />
        )}
        <h1
          className={`${WINDOW_TITLE} ${working ? "text-shimmer" : ""}`}
          title={title}
        >
          {title}
        </h1>
        {session.exit && (
          <Badge variant="secondary" className="h-5 shrink-0 px-1.5">
            exited
          </Badge>
        )}
        {/* How long it ran, in the header's own row (FE-38/D1), a Codex
            goal's beside it (FE-41/D4); the rest is the model's popover. */}
        <ConversationFacts
          facts={facts}
          extra={goal ? goalFacts(goal) : NO_FACTS}
        />
        <span className="ml-auto" />
        {error && (
          <span role="alert" className="text-destructive truncate text-xs">
            {error}
          </span>
        )}
        {/* Its model, the ring how full its context is; its usage inside. */}
        <ModelButton facts={facts} />
        {/* What it left running in the background (FE-42/D1): only when it
            started anything there. */}
        {conversation && workspace && (
          <BackgroundTasksButton
            slug={slug}
            workspace={workspace}
            session={conversation}
          />
        )}
        {/* What this conversation edited (FE-39/D1): only once there is one. */}
        {conversation && workspace && (
          <AgentFilesButton
            slug={slug}
            workspace={workspace}
            agent={conversation.agent}
            id={conversation.id}
            working={working}
            facts={facts}
          />
        )}
        {/* The same conversation as a chat (FE-62/D3). One writer at a
            time: this tab is stopped first, so not mid-turn — the chat's
            Terminal button waits the same way. */}
        {agent === "claude" && session.resume && (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={working || toChat || undefined}
            title={
              working
                ? "Wait for the turn to end, or stop it"
                : "Continue this conversation as a chat"
            }
            onClick={() => void openChat()}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            <HugeiconsIcon
              icon={MessageMultiple01Icon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            Chat
          </Button>
        )}
        {session.exit ? (
          <Button size="sm" variant="outline" onClick={() => void again(agent)}>
            <HugeiconsIcon
              icon={PlayIcon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            {conversation ? "Resume again" : "Start again"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => (working ? setConfirming(true) : void end())}
          >
            <HugeiconsIcon
              icon={StopIcon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            Stop
          </Button>
        )}
      </WindowTitlebar>
      {facts?.recap && <ConversationRecap recap={facts.recap} />}
      <div className="bg-background relative min-h-0 flex-1 px-2 pt-1">
        <XtermPane
          key={session.id}
          session={session}
          onExit={markExited}
          onOutput={() => setDrawn(session.id)}
        />
        {/* ⚠️ Until the CLI draws, a spinner rather than a blank screen: the
            host holds back the shell getting ready (FE-26), so there is
            nothing to look at yet — and nothing worth seeing. */}
        {drawn !== session.id && !session.exit && (
          <div
            role="status"
            className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-3"
          >
            <HugeiconsIcon
              icon={Loading03Icon}
              className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="text-muted-foreground text-xs">
              Starting {label}…
            </span>
          </div>
        )}
      </div>

      {/* ⚠️ Asked only while it is working (FE-26/D5): stopping an agent
          mid-task throws away what it was doing; stopping an idle one costs
          nothing — its conversation is on disk and resumes. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {label} while it is working?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Whatever it is doing now is interrupted. The conversation is kept
              and can be resumed from the Agents group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void end()}>
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
