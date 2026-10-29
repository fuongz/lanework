import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  MessageMultiple01Icon,
  SecurityCheckIcon,
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
  type ComposerSettings,
  DEFAULT_SETTINGS,
  mentionsAsNames,
  type OutgoingAttachment,
  type PermissionAnswer,
  type QueuedMessage,
  settingsFor,
} from "#/../shared/conversation";
import type { AgentSession } from "#/../shared/terminal";
import { PermissionCard } from "#/components/features/conversation/permission-card";
import { ContextButton } from "#/components/shared/agents/conversation-facts";
import { useConversationFacts } from "#/components/shared/agents/use-agent-facts";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { setChatAgent } from "#/components/shared/conversation/chat-agent";
import {
  Composer,
  type ComposerHandle,
  type Unqueued,
} from "#/components/shared/conversation/composer";
import {
  ConductorNames,
  promptLines,
  type TurnHandlers,
  TurnView,
  UserBubble,
} from "#/components/shared/conversation/turn-view";
import { ConversationSkeleton } from "#/components/shared/loading/skeletons";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  type TrustAsk,
  TrustDialog,
} from "#/components/shared/settings/trust-dialog";
import { useProjectTrust } from "#/components/shared/settings/use-project-trust";
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
import { TooltipProvider } from "#/components/ui/tooltip";
import { useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { firstLine } from "#/lib/conversation-format";
import { ipcMessage } from "#/lib/ipc-error";
import {
  conductorTurn,
  lastConductorContext,
  leadIcon,
  readConductorEnvelope,
  readEnvelope,
} from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { withLiveContext } from "#/stores/conductor-context";
import {
  type SentMessage,
  turnsSince,
  useConversationSends,
} from "#/stores/conversation-sends";
import { useNewChats } from "#/stores/new-chats";
import {
  AwaitingProposal,
  OrchestrationPanel,
  orchestrationText,
  useAwaitingProposal,
  useOrchestration,
} from "../orchestration/orchestration-panel";
import { FileOpenerProvider } from "./file-opener";
import { JobCapsules } from "./job-capsules";
import { MessageQueue } from "./message-queue";
import { TocRail } from "./toc-rail";
import { useConversation } from "./use-conversation";

const ROUTE = "/_app/w/$slug/agents/chat/$conversation" as const;

/**
 * The mark before the chat's title: the title's line height, nudged down a
 * pixel, so it sits on the middle of the lower-case text it leads rather
 * than of the line box.
 */
const TITLE_MARK = "flex h-5 shrink-0 translate-y-px items-center";
/** Stable empties: a memoized turn compares these by reference. */
/** Closer than this to the end and the view sticks to it as text streams. */
const BOTTOM_SLACK = 48;

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
 * A conversation as a chat: its turns, folded tool calls and per-turn usage,
 * and a composer that sends the next turn through the user's own CLI.
 */
export function ConversationView() {
  const { slug, conversation } = useParams({ from: ROUTE });
  // NOTE: Keyed by WHICH conversation: the route stays mounted from one to the
  // next, and the last one's scroll, draft and folds are not this one's.
  return (
    <ConversationPage
      key={`${slug}:${conversation}`}
      slug={slug}
      id={conversation}
    />
  );
}

function ConversationPage({ slug, id }: { slug: string; id: string }) {
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const {
    conversation,
    error,
    engine,
    engineLoaded,
    delta,
    permissions,
    setEngine,
  } = useConversation(workspace, id);
  // The CLI whose conversation it is — Claude Code or Codex — once read.
  const agent = conversation?.agent ?? null;
  const label = AGENT_LABELS[agent ?? "claude"];
  useEffect(() => {
    setChatAgent(agent);
    return () => setChatAgent(null);
  }, [agent]);
  // A worker of an orchestration run (FE-87): read-only here, its title bar
  // leads back to the lead's conversation.
  const runs = useOrchestrationRuns(workspace);
  const asWorker = useMemo(() => {
    for (const run of runs) {
      const task = run.tasks.find((entry) => entry.conversation === id);
      if (task) return { run, task };
    }
    return null;
  }, [runs, id]);
  const leadTitle = useAgentSessions((state) =>
    asWorker && workspace
      ? state.byWorkspace[workspace]?.find(
          (entry) =>
            entry.agent === asWorker.run.leadAgent &&
            entry.id === asWorker.run.lead,
        )?.title
      : undefined,
  );
  const openLead = () => {
    if (asWorker)
      void navigate({
        to: "/w/$slug/agents/chat/$conversation",
        params: { slug, conversation: asWorker.run.lead },
      });
  };
  const listed = useAgentSessions((state) =>
    workspace && agent
      ? state.byWorkspace[workspace]?.find(
          (entry) => entry.agent === agent && entry.id === id,
        )
      : undefined,
  );
  const facts = useConversationFacts(workspace, agent ?? "claude", id);

  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  // A conversation just started from the new page: its first message,
  // until the transcript has it.
  const {
    sent,
    setSent,
    error: actionError,
    setError: setActionError,
  } = useConversationSends(JSON.stringify([slug, id]));
  const [forking, setForking] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  // Settings are the conversation's own (D9): what it last ran with here,
  // else the last used anywhere.
  const loaded = conversation !== null;
  const own = conversation?.settings ?? null;
  // NOTE: On the conversation's own CLI: the last used anywhere may be the
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
  const userTurns = useMemo(
    () => conversation?.turns.filter((turn) => turn.role === "user") ?? [],
    [conversation],
  );
  const lastUser = userTurns.at(-1)?.id ?? null;
  // What the engine holds back, drawn above the composer instead.
  const queue = (engine.state !== "terminal" && engine.queue) || NOTHING;
  const paused = engine.state !== "terminal" && engine.paused === true;
  // FE-101: read from each CLI's own record, so the banner stands before the
  // first turn too, and goes once the user trusts the folder.
  const {
    trust,
    busy: trusting,
    error: trustError,
    set: setTrust,
  } = useProjectTrust(workspace ?? null);
  const [trustAsk, setTrustAsk] = useState<TrustAsk | null>(null);
  const untrusted =
    engine.state !== "terminal" &&
    agent !== null &&
    trust !== null &&
    trust.folder !== null &&
    !trust[agent].trusted;
  const held = useMemo(() => new Set(queue.map((entry) => entry.id)), [queue]);
  // What was sent from here and is in the transcript now drops away.
  const landed = useCallback(
    (entry: SentMessage) =>
      entry.expect !== null &&
      turnsSince(userTurns, entry.since).length >= entry.expect,
    [userTurns],
  );
  const waiting = sent.filter(
    (entry) => !held.has(entry.key) && !landed(entry),
  );
  useEffect(() => {
    setSent((previous) =>
      previous.some(landed)
        ? previous.filter((entry) => !landed(entry))
        : previous,
    );
  }, [landed, setSent]);

  const landedRef = useRef(landed);
  landedRef.current = landed;
  const lastRef = useRef(lastUser);
  lastRef.current = lastUser;
  const heldRef = useRef(held);
  heldRef.current = held;
  const userTurnsRef = useRef(userTurns);
  userTurnsRef.current = userTurns;
  /** Queued messages being taken back out: not gone to the CLI. */
  const taking = useRef(new Set<string>());
  /** Held messages the engine let go: in flight now, landing in order. */
  const release = useCallback(() => {
    if (!engineLoaded || !loaded) return;
    setSent((previous) => {
      const since = lastRef.current;
      let flying = previous.filter(
        (entry) => entry.expect !== null && !landedRef.current(entry),
      ).length;
      let changed = false;
      const next = previous.flatMap((entry) => {
        if (
          entry.expect !== null ||
          heldRef.current.has(entry.key) ||
          taking.current.has(entry.key)
        )
          return [entry];
        changed = true;
        // A queued turn may already have landed while this page was closed.
        if (
          turnsSince(userTurnsRef.current, entry.since).some(
            (turn) =>
              turn.text === entry.text &&
              turn.attachments.length === entry.attachments.length,
          )
        )
          return [];
        flying++;
        return [{ ...entry, since, expect: flying }];
      });
      return changed ? next : previous;
    });
  }, [engineLoaded, loaded, setSent]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of what is held.
  useEffect(release, [held, release]);

  const running = engine.state === "running" || engine.state === "starting";
  // NOTE: One writer per conversation (D3). A Lanework tab running it is
  // where it lives: the chat opens that tab instead of asking. A Claude in
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
  // `/orchestrate` (FE-87): its planning prompt and proposal JSON stay out of
  // what is drawn; `turns` itself keeps them so sends still match on landing.
  const orchestration = useOrchestration({
    workspace,
    lead: id,
    leadAgent: agent,
    turns,
    working,
    cwd: conversation?.cwd ?? null,
    send: (text, attachments, names) => send(text, attachments, names),
  });
  const shown = orchestration.turns;
  const awaiting = useAwaitingProposal(orchestration);
  // The conductor this conversation belongs to (FE-95), once both the
  // listing (or the start that is ahead of it) and the leads are read.
  const startedFor = useNewChats((state) => state.started[id]?.conductor);
  const conductorId = listed?.conductor ?? startedFor ?? null;
  const conductor = conductorId
    ? (orchestration.leads?.find((entry) => entry.id === conductorId) ?? null)
    : null;
  // `@id` in a prompt shows the conductor's name (FE-95).
  const conductorNames = useMemo(
    () =>
      new Map(
        (orchestration.leads ?? []).map((lead) => [
          lead.id,
          { name: lead.name, icon: lead.icon },
        ]),
      ),
    [orchestration.leads],
  );
  // In a conductor's conversation, `/orchestrate` plans as that conductor.
  const orchestrate: typeof orchestration.orchestrate = (
    request,
    attachments,
    names,
    teamLead,
  ) =>
    orchestration.orchestrate(
      request,
      attachments,
      names,
      teamLead ?? conductor,
    );

  // ─── Scrolling ────────────────────────────────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState<string | null>(null);
  const entries = useMemo(() => promptLines(shown), [shown]);
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

  // NOTE: Only the READER moving up lets go of the end. The view also moves
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

  // NOTE: Stick to the end while text streams, only if the reader was there:
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
    [workspace, id, setActionError],
  );

  const handlers = useMemo<TurnHandlers>(
    () => ({
      // Forking copies a Claude transcript; Codex's are not forked here.
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
      // A worker has no composer to reply into (FE-91/U18).
      onReply: asWorker
        ? undefined
        : (text) => {
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
    [
      workspace,
      id,
      forking,
      navigate,
      slug,
      answer,
      agent,
      label,
      setActionError,
      asWorker,
    ],
  );

  const send = async (
    typed: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean }[],
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!workspace || !surface || !settings) return false;
    setActionError(null);
    // A conductor's message carries who it is (FE-95); a planning or repair
    // prompt already names its lead.
    const text =
      conductor &&
      agent &&
      !readEnvelope(typed) &&
      !readConductorEnvelope(typed)
        ? conductorTurn(
            typed,
            await withLiveContext(workspace, conductor),
            agent,
            conversation?.cwd ?? null,
            lastConductorContext(turns),
          )
        : typed;
    const key = `s${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setSent((previous) => [
      ...previous,
      {
        key,
        text,
        since: lastUser,
        attachments: names.map((entry) => ({
          name: entry.name,
          mediaType: entry.image ? "image/*" : "text/plain",
          path: null,
        })),
        expect:
          previous.filter((e) => e.expect !== null && !landed(e)).length + 1,
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
   * Takes queued messages out: dropped, or back to the composer.
   *
   * NOTE: One may go to the CLI meanwhile, so only what main says it removed
   * leaves.
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

  const _session: AgentSession = listed ?? {
    id,
    agent: agent ?? "claude",
    title: "",
    cliTitle: "",
    updatedAt: new Date().toISOString(),
    pinnedAt: null,
    conductor: null,
    working: false,
    card: null,
    subagents: [],
    background: { running: 0, total: 0 },
  };

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const firstPrompt = shown.find((turn) => turn.role === "user");
  const title =
    asWorker?.task.title ||
    conductor?.name ||
    listed?.title ||
    (firstPrompt?.role === "user"
      ? firstLine(mentionsAsNames(firstPrompt.text))
      : "") ||
    `${label} conversation`;

  const lastPromptAt =
    [...turns].reverse().find((turn) => turn.role === "user")?.at ?? null;
  const last = shown[shown.length - 1];
  const lastOpen = last?.role === "assistant" && last.open ? last : null;
  // What waits on the user, drawn in the composer's place, not the turn: a
  // question (AskUserQuestion) or a tool's permission, as the CLI asks both
  // at its own prompt.
  const asking = permissions;
  // Streamed text before the turn has a line of its own.
  const stream: AssistantTurn | null =
    !lastOpen && delta
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

  return (
    <TooltipProvider delay={200}>
      <section
        aria-label={`${label} — ${title}`}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        <WindowTitlebar className="gap-2.5">
          {/* A worker's breadcrumb: its lead's conversation, then itself. */}
          {asWorker && (
            <>
              <button
                type="button"
                onClick={openLead}
                title={`Back to the lead: ${leadTitle ?? "its conversation"}`}
                className="text-muted-foreground hover:text-foreground flex max-w-[40%] min-w-0 shrink items-center gap-1.5 text-[13px] transition-colors"
              >
                <TerminalKindIcon
                  kind={asWorker.run.leadAgent}
                  className="size-[13px] shrink-0"
                />
                <span className="truncate">{leadTitle ?? "Lead"}</span>
              </button>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="text-muted-foreground size-3 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
            </>
          )}
          {working ? (
            <span role="img" aria-label="Working" className={TITLE_MARK}>
              <OrbitSpinner className="text-foreground size-[13px]" />
            </span>
          ) : conductor ? (
            <span className={TITLE_MARK}>
              <HugeiconsIcon
                icon={leadIcon(conductor.icon)}
                className="size-[13px]"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </span>
          ) : (
            agent && (
              <span className={TITLE_MARK}>
                <TerminalKindIcon kind={agent} className="size-[13px]" />
              </span>
            )
          )}
          <h1
            className={cn(WINDOW_TITLE, "leading-5", working && "text-shimmer")}
            title={title}
          >
            {title}
          </h1>
          <span className="ml-auto" />
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
                  <ConversationSkeleton label="Reading the conversation" />
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
                <ConductorNames.Provider value={conductorNames}>
                  <FileOpenerProvider
                    slug={slug}
                    workspace={workspace}
                    conversation={id}
                  >
                    {shown.map((turn) => (
                      <TurnView
                        key={turn.id}
                        turn={turn}
                        delta={turn === lastOpen ? delta : ""}
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
                        slug={slug}
                        conversation={id}
                        handlers={handlers}
                        forking={forking}
                      />
                    )}
                    {waiting.map((entry) => (
                      <UserBubble
                        key={entry.key}
                        text={orchestrationText(entry.text)}
                        attachments={entry.attachments}
                        time={null}
                        pending="Sending…"
                      />
                    ))}
                    <OrchestrationPanel
                      slug={slug}
                      orchestration={orchestration}
                    />
                  </FileOpenerProvider>
                </ConductorNames.Provider>
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
          {untrusted && agent && (
            <div
              role="status"
              className="text-muted-foreground flex items-center gap-3 px-1 text-xs"
            >
              <p className="min-w-0 flex-1">
                {agent === "claude" ? (
                  <>
                    This chat runs without the project’s <code>.claude</code>{" "}
                    settings, because Claude Code doesn’t trust this folder.
                  </>
                ) : (
                  <>
                    This chat runs without the project’s <code>.codex</code>{" "}
                    config and <code>AGENTS.md</code>, because Codex doesn’t
                    trust this folder.
                  </>
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={trusting !== null}
                onClick={() => setTrustAsk({ agent, on: true })}
              >
                <HugeiconsIcon
                  icon={SecurityCheckIcon}
                  strokeWidth={1.5}
                  data-icon="inline-start"
                />
                {trusting === agent ? "Trusting…" : "Trust this folder"}
              </Button>
            </div>
          )}
          {trustError && (
            <p role="alert" className="text-destructive px-1 text-xs">
              {trustError}
            </p>
          )}
          <TrustDialog
            ask={trustAsk}
            folder={trust?.folder ?? null}
            onClose={() => setTrustAsk(null)}
            onConfirm={(request) => {
              setTrustAsk(null);
              void setTrust(request.agent, request.on);
            }}
          />
          {workspace && (
            <JobCapsules
              slug={slug}
              workspace={workspace}
              session={listed}
              since={lastPromptAt}
            />
          )}
          {/* NOTE: Claude's question stands where the prompt is typed, the
              way the CLI asks it at its own prompt. The composer stays
              mounted under it — hidden, not unmounted — so a draft
              survives. */}
          {/* A proposal waiting for Approve stands here too, above the
              prompt, so it is never scrolled away (FE-95). */}
          {awaiting && !asWorker && (
            <div className="max-h-[50vh] overflow-y-auto rounded-xl shadow-xs">
              <AwaitingProposal
                orchestration={orchestration}
                proposal={awaiting}
              />
            </div>
          )}
          {!asWorker &&
            asking.map((request) => (
              // The composer's shadow: it stands where the prompt is.
              <div key={request.id} className="rounded-xl shadow-xs">
                <PermissionCard
                  request={request}
                  agent={label}
                  onAnswer={answer}
                />
              </div>
            ))}
          {asWorker && (
            <p className="text-muted-foreground border-border rounded-xl border px-4 py-3 text-[13px]">
              Read-only. This worker takes its instructions from{" "}
              <button
                type="button"
                onClick={openLead}
                className="text-foreground underline-offset-2 hover:underline"
              >
                its lead
              </button>
              , which answers its questions and reviews its work.
            </p>
          )}
          {workspace && settings && !asWorker && (
            <div className={asking.length ? "hidden" : "flex flex-col"}>
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
                onOrchestrate={orchestrate}
                onStop={stop}
                onEditLastQueued={() => {
                  // A queued repair has nothing typed to give back (FE-91).
                  const last = [...queue]
                    .reverse()
                    .find((item) => readEnvelope(item.text)?.kind !== "repair");
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
