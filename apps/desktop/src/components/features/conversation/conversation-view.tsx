import {
  Alert02Icon,
  ArrowDown01Icon,
  ComputerTerminal01Icon,
  Loading03Icon,
  MessageMultiple01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AGENT_LABELS,
  type AssistantTurn,
  type Attachment,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  type OutgoingAttachment,
  type PermissionAnswer,
  type PermissionRequest,
  type QueuedMessage,
  settingsFor,
} from "#/../shared/conversation";
import type { AgentSession } from "#/../shared/terminal";
import { ContextButton } from "#/components/shared/agents/conversation-facts";
import { PermissionCard } from "#/components/shared/agents/permission-card";
import { useConversationFacts } from "#/components/shared/agents/use-agent-facts";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { setChatAgent } from "#/components/shared/conversation/chat-agent";
import {
  Composer,
  type ComposerHandle,
  type Unqueued,
} from "#/components/shared/conversation/composer";
import { takeFirstMessage } from "#/components/shared/conversation/first-message";
import {
  promptLines,
  type TurnHandlers,
  TurnView,
  UserBubble,
} from "#/components/shared/conversation/turn-view";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { firstLine } from "#/lib/conversation-format";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { FileOpenerProvider } from "./file-opener";
import { JobCapsules } from "./job-capsules";
import { MessageQueue } from "./message-queue";
import { TocRail } from "./toc-rail";
import { useConversation } from "./use-conversation";

const ROUTE = "/_app/w/$slug/agents/chat/$conversation" as const;
/** Stable empties: a memoized turn compares these by reference. */
const NO_PERMISSIONS: PermissionRequest[] = [];
/** Closer than this to the end and the view sticks to it as text streams. */
const BOTTOM_SLACK = 48;

/** A message sent from here that the transcript does not have yet. */
interface Sent {
  key: string;
  text: string;
  attachments: Attachment[];
  /**
   * User turns the transcript must reach for this one to be in it — null
   * while the engine holds it back (FE-67): it is counted once it goes.
   */
  expect: number | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const NOTHING: QueuedMessage[] = [];

/** A queued message's files, as the composer shows them again. */
function unqueued(taken: {
  text: string;
  attachments: OutgoingAttachment[];
}): Unqueued {
  return {
    text: taken.text,
    attachments: taken.attachments.map((out) =>
      out.kind === "path"
        ? {
            name: out.path.split("/").pop() || out.path,
            image: IMAGE.test(out.path),
            out,
          }
        : { name: out.name, image: true, out },
    ),
  };
}

/**
 * A Claude conversation as a chat (FE-62): its turns, folded tool calls and
 * per-turn usage, and a composer that sends the next turn through the
 * user's own `claude` CLI.
 */
export function ConversationView() {
  const { slug, conversation } = useParams({ from: ROUTE });
  // ⚠️ Keyed by WHICH conversation: the route stays mounted from one to the
  // next, and the last one's scroll, draft and folds are not this one's.
  return <ConversationPage key={conversation} slug={slug} id={conversation} />;
}

function ConversationPage({ slug, id }: { slug: string; id: string }) {
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const { conversation, error, engine, delta, permissions, setEngine } =
    useConversation(workspace, id);
  // The CLI whose conversation it is — Claude Code or Codex — once read.
  const agent = conversation?.agent ?? null;
  const label = AGENT_LABELS[agent ?? "claude"];
  useEffect(() => {
    setChatAgent(agent);
    return () => setChatAgent(null);
  }, [agent]);
  const listed = useAgentSessions((state) =>
    workspace && agent
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.agent === agent && entry.id === id,
        )
      : undefined,
  );
  const resume = useAgentTerminals((state) => state.resume);
  const facts = useConversationFacts(workspace, agent ?? "claude", id);

  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  // A conversation just started from the new page: its first message,
  // until the transcript has it.
  const [sent, setSent] = useState<Sent[]>(() => {
    const first = takeFirstMessage(id);
    return first ? [{ key: "first", ...first, expect: 1 }] : [];
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  // Settings are the conversation's own (D9): what it last ran with here,
  // else the last used anywhere.
  const loaded = conversation !== null;
  const own = conversation?.settings ?? null;
  // ⚠️ On the conversation's own CLI: the last used anywhere may be the
  // other one's model.
  useEffect(() => {
    if (!loaded || settings || !agent) return;
    if (own) {
      setSettings(settingsFor(agent, own));
      return;
    }
    let gone = false;
    const surface = window.desktop?.conversation;
    void (surface ? surface.lastSettings() : Promise.resolve(DEFAULT_SETTINGS))
      .catch(() => DEFAULT_SETTINGS)
      .then((last) => {
        if (!gone)
          setSettings((current) => current ?? settingsFor(agent, last));
      });
    return () => {
      gone = true;
    };
  }, [loaded, own, settings, agent]);

  const turns = conversation?.turns ?? [];
  const users = turns.filter((turn) => turn.role === "user").length;
  // What the engine holds back (FE-67), drawn above the composer instead.
  const queue = (engine.state !== "terminal" && engine.queue) || NOTHING;
  const paused = engine.state !== "terminal" && engine.paused === true;
  const held = useMemo(() => new Set(queue.map((entry) => entry.id)), [queue]);
  // What was sent from here and is in the transcript now drops away.
  const waiting = sent.filter(
    (entry) =>
      !held.has(entry.key) && (entry.expect === null || users < entry.expect),
  );
  useEffect(() => {
    setSent((previous) =>
      previous.some((entry) => entry.expect !== null && users >= entry.expect)
        ? previous.filter(
            (entry) => entry.expect === null || users < entry.expect,
          )
        : previous,
    );
  }, [users]);

  const usersRef = useRef(users);
  usersRef.current = users;
  const heldRef = useRef(held);
  heldRef.current = held;
  /** Queued messages being taken back out: not gone to the CLI. */
  const taking = useRef(new Set<string>());
  /** Held messages the engine let go: in flight now, landing in order. */
  const release = useCallback(() => {
    setSent((previous) => {
      const now = usersRef.current;
      let flying = previous.filter(
        (entry) => entry.expect !== null && now < entry.expect,
      ).length;
      let changed = false;
      const next = previous.map((entry) => {
        if (
          entry.expect !== null ||
          heldRef.current.has(entry.key) ||
          taking.current.has(entry.key)
        )
          return entry;
        changed = true;
        flying++;
        return { ...entry, expect: now + flying };
      });
      return changed ? next : previous;
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of what is held.
  useEffect(release, [held, release]);

  const running = engine.state === "running" || engine.state === "starting";
  // ⚠️ One writer per conversation (D3). A Lanework tab running it is where
  // it lives now: the chat opens that tab instead of asking. A Claude in
  // another terminal app has no tab to open; a send then says so.
  const tab =
    engine.state === "terminal" && !engine.terminalId.startsWith("pid:")
      ? engine.terminalId
      : null;
  useEffect(() => {
    if (tab)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: tab },
        replace: true,
      });
  }, [tab, navigate, slug]);
  const working = running || (conversation?.working ?? false);

  // ─── Scrolling ────────────────────────────────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState<string | null>(null);
  const entries = useMemo(() => promptLines(turns), [turns]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const anchor = useCallback((turnId: string, node: HTMLElement | null) => {
    if (node) anchors.current.set(turnId, node);
    else anchors.current.delete(turnId);
  }, []);

  /** The prompt the reader is in: the last one above a third of the view. */
  const locate = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const line = box.getBoundingClientRect().top + box.clientHeight * 0.3;
    let found: string | null = null;
    for (const entry of entriesRef.current) {
      const node = anchors.current.get(entry.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= line) found = entry.id;
      else break;
    }
    setCurrent(found ?? entriesRef.current[0]?.id ?? null);
  }, []);

  const frame = useRef(0);
  /** The scroller as the last scroll event left it. */
  const seen = useRef({ top: 0, height: 0, view: 0 });
  /** When the reader last touched the scroller: wheel, key, touch, pointer. */
  const touched = useRef(0);

  const toBottom = useCallback((smooth: boolean) => {
    const box = scroller.current;
    if (!box) return;
    box.scrollTo({
      top: box.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // ⚠️ Only the READER moving up lets go of the end. The view also moves
  // under them: the composer mounting shrinks it, and turns drawn with
  // `content-visibility` settle smaller than their placeholder, which clamps
  // `scrollTop` down. Those keep it stuck. A move up counts as the reader's
  // when they just touched the scroller, or when nothing changed size.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.scrollTop;
    const height = box.scrollHeight;
    const view = box.clientHeight;
    const near = height - top - view < BOTTOM_SLACK;
    const up = top < seen.current.top;
    const reader =
      performance.now() - touched.current < 600 ||
      (height === seen.current.height && view === seen.current.view);
    if (near) atBottom.current = true;
    else if (up && reader) atBottom.current = false;
    else if (atBottom.current) toBottom(false);
    seen.current = { top, height, view };
    setShowDown(!atBottom.current);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(locate);
  };

  // ⚠️ Stick to the end while text streams — only if the reader was there:
  // one who scrolled up to read is never pulled away.
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) toBottom(false);
      locate();
    });
    observer.observe(node);
    // The view itself, too: it shrinks when the composer mounts.
    const box = scroller.current;
    if (box) observer.observe(box);
    const touch = () => {
      touched.current = performance.now();
    };
    const inputs = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const type of inputs)
      box?.addEventListener(type, touch, { passive: true });
    return () => {
      observer.disconnect();
      for (const type of inputs) box?.removeEventListener(type, touch);
    };
  }, [toBottom, locate]);

  const jump = useCallback((turnId: string) => {
    anchors.current
      .get(turnId)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const answer = useCallback(
    async (request: string, value: PermissionAnswer) => {
      if (!workspace) return;
      try {
        await window.desktop?.conversation.answerPermission(
          workspace,
          id,
          request,
          value,
        );
      } catch (caught) {
        setActionError(ipcMessage(caught, "Could not answer the request."));
      }
    },
    [workspace, id],
  );

  const handlers = useMemo<TurnHandlers>(
    () => ({
      // ⚠️ Forking copies a Claude transcript; Codex's are not forked here.
      onFork:
        agent === "codex"
          ? undefined
          : () => {
              if (!workspace || forking) return;
              setForking(true);
              setActionError(null);
              void window.desktop?.conversation
                .fork(workspace, id)
                .then((next) =>
                  navigate({
                    to: "/w/$slug/agents/chat/$conversation",
                    params: { slug, conversation: next },
                  }),
                )
                .catch((caught: unknown) =>
                  setActionError(ipcMessage(caught, "Could not fork.")),
                )
                .finally(() => setForking(false));
            },
      onReply: (text) => {
        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 3);
        composer.current?.insert(
          `${lines.map((line) => `> ${line}`).join("\n")}\n\n`,
        );
      },
      onAnswer: answer,
      agent: label,
    }),
    [workspace, id, forking, navigate, slug, answer, agent, label],
  );

  const send = async (
    text: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface || !settings) return false;
    setActionError(null);
    const key = `s${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setSent((previous) => [
      ...previous,
      {
        key,
        text,
        attachments: names.map((entry) => ({
          name: entry.name,
          mediaType: entry.image ? "image/*" : "text/plain",
          path: null,
        })),
        expect:
          users +
          previous.filter((e) => e.expect !== null && users < e.expect).length +
          1,
      },
    ]);
    atBottom.current = true;
    requestAnimationFrame(() => toBottom(true));
    try {
      const next = await surface.send({
        workspace,
        conversation: id,
        id: key,
        text,
        attachments,
        settings,
      });
      setEngine(next);
      // Held back: counted once the engine lets it go.
      if (next.state !== "terminal" && next.queue?.some((m) => m.id === key))
        setSent((previous) =>
          previous.map((entry) =>
            entry.key === key ? { ...entry, expect: null } : entry,
          ),
        );
      if (next.state === "terminal") {
        // Nothing was sent: another process writes it (D3).
        setSent((previous) => previous.filter((entry) => entry.key !== key));
        setActionError(
          `${label} is running this conversation in another terminal. Exit it there to continue here.`,
        );
        return false;
      }
      return true;
    } catch (caught) {
      setSent((previous) => previous.filter((entry) => entry.key !== key));
      setActionError(ipcMessage(caught, "Could not send."));
      return false;
    }
  };

  const stop = () => {
    if (!workspace) return;
    void window.desktop?.conversation
      .stop(workspace, id)
      .catch((caught: unknown) =>
        setActionError(ipcMessage(caught, "Could not stop.")),
      );
  };

  /**
   * Queued messages taken out — dropped, or back to the composer. ⚠️ One
   * may go to the CLI meanwhile: only what main says it removed leaves.
   */
  const unqueue = async (
    keys: string[],
    take: () => Promise<string[]>,
  ): Promise<void> => {
    for (const key of keys) taking.current.add(key);
    try {
      const gone = new Set(await take());
      setSent((previous) => previous.filter((entry) => !gone.has(entry.key)));
    } finally {
      for (const key of keys) taking.current.delete(key);
      release();
    }
  };

  const clearQueue = () => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface) return;
    const keys = [...held];
    void unqueue(keys, async () =>
      (await surface.clearQueue(workspace, id)) ? keys : [],
    ).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not clear the queue.")),
    );
  };

  const removeQueued = (key: string) => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface) return;
    void unqueue([key], async () =>
      (await surface.removeQueued(workspace, id, key)) ? [key] : [],
    ).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not remove it.")),
    );
  };

  /** Back to the composer to be edited; sent again, it queues again (D3). */
  const editQueued = (key: string) => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface) return;
    void unqueue([key], async () => {
      const taken = await surface.takeQueued(workspace, id, key);
      if (!taken) return [];
      composer.current?.restore(unqueued(taken));
      return [key];
    }).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not edit it.")),
    );
  };

  const resumeQueue = () => {
    if (!workspace) return;
    void window.desktop?.conversation
      .resumeQueue(workspace, id)
      .catch((caught: unknown) =>
        setActionError(ipcMessage(caught, "Could not resume.")),
      );
  };

  const session: AgentSession = listed ?? {
    id,
    agent: agent ?? "claude",
    title: "",
    cliTitle: "",
    updatedAt: new Date().toISOString(),
    pinnedAt: null,
    working: false,
    card: null,
    subagents: [],
    background: { running: 0, total: 0 },
  };

  /** Hand the conversation to a terminal (D3): one writer at a time. */
  const openTerminal = async () => {
    if (!workspace) return;
    if (engine.state === "terminal") {
      if (tab)
        void navigate({
          to: "/w/$slug/agents/$terminalId",
          params: { slug, terminalId: tab },
        });
      else
        setActionError(
          `${label} is running this conversation in another terminal.`,
        );
      return;
    }
    setSwitching(true);
    setActionError(null);
    try {
      await window.desktop?.conversation.release(workspace, id);
      const next = await resume(workspace, session);
      if (next)
        void navigate({
          to: "/w/$slug/agents/$terminalId",
          params: { slug, terminalId: next.id },
        });
    } catch (caught) {
      setActionError(ipcMessage(caught, "Could not open a terminal."));
    } finally {
      setSwitching(false);
    }
  };

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const firstPrompt = turns.find((turn) => turn.role === "user");
  const title =
    listed?.title ||
    (firstPrompt?.role === "user" ? firstLine(firstPrompt.text) : "") ||
    `${label} conversation`;

  const lastPromptAt =
    [...turns].reverse().find((turn) => turn.role === "user")?.at ?? null;
  const last = turns[turns.length - 1];
  const lastOpen = last?.role === "assistant" && last.open ? last : null;
  // AskUserQuestion, waiting: drawn in the composer's place, not the turn.
  const question = permissions.find((request) => request.questions) ?? null;
  // Streamed text or a permission before the turn has a line of its own.
  const stream: AssistantTurn | null =
    !lastOpen && (delta || permissions.some((request) => !request.questions))
      ? {
          role: "assistant",
          id: "__stream",
          blocks: [],
          model: null,
          usage: null,
          at: new Date().toISOString(),
          endedAt: null,
          open: true,
        }
      : null;

  // ⚠️ Only the chat's OWN engine holds the Terminal button and the
  // composer. A transcript left mid-turn by a CLI that was killed or crashed
  // still reads as working for a while, but nothing is writing it — and a
  // live CLI anywhere answers `terminal`, not this.
  const blocked = !workspace || switching || running;
  const terminalTip = running
    ? "Wait for the turn to end, or stop it"
    : "Continue this conversation in a terminal";

  return (
    <TooltipProvider delay={200}>
      <section
        aria-label={`${label} — ${title}`}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        <WindowTitlebar className="gap-2.5">
          {working ? (
            <span role="img" aria-label="Working" className="flex shrink-0">
              <OrbitSpinner className="text-foreground size-[13px]" />
            </span>
          ) : (
            agent && (
              <TerminalKindIcon kind={agent} className="size-[13px] shrink-0" />
            )
          )}
          <h1
            className={cn(WINDOW_TITLE, working && "text-shimmer")}
            title={title}
          >
            {title}
          </h1>
          <span className="ml-auto" />
          {/* The same conversation in a terminal (D3), where the agent view
              has its Chat: one writer at a time, so not while a turn runs. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  // ⚠️ aria-disabled, not disabled: a disabled button gets
                  // no pointer events, and its tooltip says why it is off.
                  aria-disabled={blocked || undefined}
                  onClick={() => {
                    if (!blocked) void openTerminal();
                  }}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                />
              }
            >
              <HugeiconsIcon
                icon={ComputerTerminal01Icon}
                strokeWidth={1.8}
                data-icon="inline-start"
                aria-hidden="true"
              />
              Terminal
            </TooltipTrigger>
            <TooltipContent side="bottom">{terminalTip}</TooltipContent>
          </Tooltip>
        </WindowTitlebar>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            onScroll={onScroll}
            className="h-full overflow-y-auto [overflow-anchor:none]"
          >
            <div
              ref={content}
              className="mx-auto flex w-full max-w-[920px] min-w-0 flex-col gap-6 px-10 pt-6 pb-10"
            >
              {conversation?.truncated && (
                <Alert>
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                  <AlertDescription>
                    This conversation is longer than one read takes: its start
                    is not shown.
                  </AlertDescription>
                </Alert>
              )}
              {!conversation ? (
                error ? (
                  <Empty className="py-16">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                      </EmptyMedia>
                      <EmptyTitle>Could not open this conversation</EmptyTitle>
                      <EmptyDescription>{error}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div
                    role="status"
                    className="text-muted-foreground flex flex-col items-center gap-3 py-24 text-xs"
                  >
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      className="size-5 animate-spin motion-reduce:animate-none"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    Reading the conversation…
                  </div>
                )
              ) : turns.length === 0 && waiting.length === 0 && !stream ? (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <HugeiconsIcon
                        icon={MessageMultiple01Icon}
                        strokeWidth={1.8}
                      />
                    </EmptyMedia>
                    <EmptyTitle>Nothing said yet</EmptyTitle>
                    <EmptyDescription>
                      Write the first message below.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <FileOpenerProvider
                  slug={slug}
                  workspace={workspace}
                  conversation={id}
                >
                  {turns.map((turn) => (
                    <TurnView
                      key={turn.id}
                      turn={turn}
                      delta={turn === lastOpen ? delta : ""}
                      permissions={
                        turn === lastOpen ? permissions : NO_PERMISSIONS
                      }
                      slug={slug}
                      conversation={id}
                      handlers={handlers}
                      forking={forking}
                      anchor={anchor}
                    />
                  ))}
                  {stream && (
                    <TurnView
                      turn={stream}
                      delta={delta}
                      permissions={permissions}
                      slug={slug}
                      conversation={id}
                      handlers={handlers}
                      forking={forking}
                    />
                  )}
                  {waiting.map((entry) => (
                    <UserBubble
                      key={entry.key}
                      text={entry.text}
                      attachments={entry.attachments}
                      time={null}
                      pending="Sending…"
                    />
                  ))}
                </FileOpenerProvider>
              )}
            </div>
          </div>

          <TocRail entries={entries} current={current} onJump={jump} />

          {showDown && (
            <button
              type="button"
              aria-label="Scroll to the end"
              onClick={() => {
                atBottom.current = true;
                toBottom(true);
              }}
              className="bg-popover text-muted-foreground hover:text-foreground ring-foreground/10 absolute bottom-3 left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full shadow-md ring-1 transition-colors"
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                className="size-4"
                strokeWidth={2}
              />
            </button>
          )}
        </div>

        <div className="mx-auto flex w-full max-w-[940px] min-w-0 flex-col gap-1.5 px-8 pb-4">
          {(actionError || engine.state === "error") && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {actionError ??
                (engine.state === "error" ? engine.message : null)}
            </p>
          )}
          {workspace && (
            <JobCapsules
              slug={slug}
              workspace={workspace}
              session={listed}
              since={lastPromptAt}
            />
          )}
          {/* ⚠️ Claude's question stands where the prompt is typed, the way
              the CLI asks it at its own prompt. The composer stays mounted
              under it — hidden, not unmounted — so a draft survives. */}
          {question && (
            <PermissionCard
              key={question.id}
              request={question}
              agent={label}
              onAnswer={answer}
            />
          )}
          {workspace && settings && (
            <div className={question ? "hidden" : "flex flex-col"}>
              <MessageQueue
                queue={queue}
                paused={paused}
                onEdit={editQueued}
                onRemove={removeQueued}
                onResume={resumeQueue}
                onClear={clearQueue}
              />
              <Composer
                ref={composer}
                slug={slug}
                draftKey={id}
                corner={<ContextButton facts={facts} />}
                workspace={workspace}
                agent={agent}
                settings={settings}
                onSettings={(next) =>
                  setSettings((previous) =>
                    previous ? { ...previous, ...next } : previous,
                  )
                }
                working={running}
                queued={queue.length}
                onSend={send}
                onStop={stop}
                onEditLastQueued={() => {
                  const last = queue.at(-1);
                  if (last) editQueued(last.id);
                }}
              />
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}
