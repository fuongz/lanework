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
  type AssistantTurn,
  type Attachment,
  type ComposerSettings,
  DEFAULT_SETTINGS,
  type OutgoingAttachment,
  type PermissionAnswer,
  type PermissionRequest,
} from "#/../shared/conversation";
import type { AgentSession } from "#/../shared/terminal";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
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
import { Composer, type ComposerHandle } from "./composer";
import { TocRail } from "./toc-rail";
import {
  promptLines,
  type TurnHandlers,
  TurnView,
  UserBubble,
} from "./turn-view";
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
  /** User turns the transcript must reach for this one to be in it. */
  expect: number;
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
  const { conversation, error, engine, delta, permissions, setEngine, reload } =
    useConversation(workspace, id);
  const listed = useAgentSessions((state) =>
    workspace
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.agent === "claude" && entry.id === id,
        )
      : undefined,
  );
  const resume = useAgentTerminals((state) => state.resume);

  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  // Settings are the conversation's own (D9): what it last ran with here,
  // else the last used anywhere.
  const loaded = conversation !== null;
  const own = conversation?.settings ?? null;
  useEffect(() => {
    if (!loaded || settings) return;
    if (own) {
      setSettings(own);
      return;
    }
    let gone = false;
    const surface = window.desktop?.conversation;
    void (surface ? surface.lastSettings() : Promise.resolve(DEFAULT_SETTINGS))
      .catch(() => DEFAULT_SETTINGS)
      .then((last) => {
        if (!gone) setSettings((current) => current ?? last);
      });
    return () => {
      gone = true;
    };
  }, [loaded, own, settings]);

  const turns = conversation?.turns ?? [];
  const users = turns.filter((turn) => turn.role === "user").length;
  // What was sent from here and is in the transcript now drops away.
  const waiting = sent.filter((entry) => users < entry.expect);
  useEffect(() => {
    setSent((previous) =>
      previous.some((entry) => users >= entry.expect)
        ? previous.filter((entry) => users < entry.expect)
        : previous,
    );
  }, [users]);

  const running = engine.state === "running" || engine.state === "starting";
  const inTerminal = engine.state === "terminal";
  const working = running || (conversation?.working ?? false);
  const queued = engine.state === "running" ? engine.queued : 0;

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
      onFork: () => {
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
    }),
    [workspace, id, forking, navigate, slug, answer],
  );

  const send = async (
    text: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface || !settings) return false;
    setActionError(null);
    const key = `s${Date.now()}${Math.random()}`;
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
        expect: users + previous.filter((e) => users < e.expect).length + 1,
      },
    ]);
    atBottom.current = true;
    requestAnimationFrame(() => toBottom(true));
    try {
      setEngine(
        await surface.send({
          workspace,
          conversation: id,
          text,
          attachments,
          settings,
        }),
      );
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

  const clearQueue = () => {
    if (!workspace) return;
    void window.desktop?.conversation
      .clearQueue(workspace, id)
      .then(() =>
        // The queued ones will never land: the last `queued` sent go.
        setSent((previous) => previous.slice(0, previous.length - queued)),
      )
      .catch((caught: unknown) =>
        setActionError(ipcMessage(caught, "Could not clear the queue.")),
      );
  };

  const session: AgentSession = listed ?? {
    id,
    agent: "claude",
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
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: engine.terminalId },
      });
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

  const takeOver = () => {
    if (!workspace) return;
    void window.desktop?.conversation
      .takeOver(workspace, id)
      .then((next) => {
        setEngine(next);
        reload();
      })
      .catch((caught: unknown) =>
        setActionError(ipcMessage(caught, "Could not continue here.")),
      );
  };

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const firstPrompt = turns.find((turn) => turn.role === "user");
  const title =
    listed?.title ||
    (firstPrompt?.role === "user" ? firstLine(firstPrompt.text) : "") ||
    "Claude conversation";

  const last = turns[turns.length - 1];
  const lastOpen = last?.role === "assistant" && last.open ? last : null;
  // Streamed text or a permission before the turn has a line of its own.
  const stream: AssistantTurn | null =
    !lastOpen && (delta || permissions.length > 0)
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
        aria-label={`Claude — ${title}`}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        <WindowTitlebar className="gap-2.5">
          {working ? (
            <span role="img" aria-label="Working" className="flex shrink-0">
              <OrbitSpinner className="text-foreground size-[13px]" />
            </span>
          ) : (
            <TerminalKindIcon kind="claude" className="size-[13px] shrink-0" />
          )}
          <h1
            className={cn(WINDOW_TITLE, working && "text-shimmer")}
            title={title}
          >
            {title}
          </h1>
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
                <>
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
                  {waiting.map((entry, index) => (
                    <UserBubble
                      key={entry.key}
                      text={entry.text}
                      attachments={entry.attachments}
                      time={null}
                      // The last `queued` wait behind the running turn.
                      pending={
                        index >= waiting.length - queued ? "Queued" : "Sending…"
                      }
                    />
                  ))}
                </>
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

        <div className="mx-auto flex w-full max-w-[940px] min-w-0 flex-col gap-1.5 px-8 pb-2">
          {(actionError || engine.state === "error") && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {actionError ??
                (engine.state === "error" ? engine.message : null)}
            </p>
          )}
          {inTerminal ? (
            // ⚠️ One writer per conversation (D3): while a pty runs Claude on
            // it, nothing is sent from here until one of the two lets go.
            <div className="bg-card border-border flex items-center gap-3 rounded-xl border px-4 py-3">
              <HugeiconsIcon
                icon={ComputerTerminal01Icon}
                className="text-muted-foreground size-4 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-[13px]">
                Running in Terminal
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openTerminal()}
              >
                Open Terminal
              </Button>
              <Button size="sm" onClick={takeOver}>
                Continue here
              </Button>
            </div>
          ) : (
            workspace &&
            settings && (
              <Composer
                ref={composer}
                workspace={workspace}
                branch={conversation?.branch ?? null}
                settings={settings}
                onSettings={(next) =>
                  setSettings((previous) =>
                    previous ? { ...previous, ...next } : previous,
                  )
                }
                working={running}
                queued={queued}
                onSend={send}
                onStop={stop}
                onClearQueue={clearQueue}
              />
            )
          )}
          <div className="flex h-6 items-center justify-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    // ⚠️ aria-disabled, not disabled: a disabled button gets
                    // no pointer events, and its tooltip says why it is off.
                    aria-disabled={blocked || undefined}
                    onClick={() => {
                      if (!blocked) void openTerminal();
                    }}
                    className="text-tone-sky hover:text-foreground aria-disabled:hover:text-tone-sky flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  />
                }
              >
                <HugeiconsIcon
                  icon={ComputerTerminal01Icon}
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Terminal
              </TooltipTrigger>
              <TooltipContent side="top">{terminalTip}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </section>
    </TooltipProvider>
  );
}
