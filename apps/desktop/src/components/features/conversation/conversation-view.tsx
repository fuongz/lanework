import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Flowchart01Icon,
  MessageMultiple01Icon,
  MoreHorizontalIcon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Fragment,
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
  agentOfModel,
  type CompactionTurn,
  type ComposerSettings,
  type ConversationAgent,
  DEFAULT_SETTINGS,
  mentionsAsNames,
  type OutgoingAttachment,
  type PermissionAnswer,
  type QueuedMessage,
  settingsFor,
  type UserTurn,
} from "#/../shared/conversation";
import { canLead } from "#/../shared/orchestration";
import { type AgentSession, userMayActOn } from "#/../shared/terminal";
import { PermissionStack } from "#/components/features/conversation/permission-stack";
import { ContextButton } from "#/components/shared/agents/conversation-facts";
import { RenameAgentDialog } from "#/components/shared/agents/rename-agent-dialog";
import { useConversationFacts } from "#/components/shared/agents/use-agent-facts";
import { OrbitSpinner } from "#/components/shared/common/orbit-spinner";
import { ConductorMark } from "#/components/shared/conductors/conductor-mark";
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
  type TrustAsk,
  TrustDialog,
} from "#/components/shared/settings/trust-dialog";
import { useProjectTrust } from "#/components/shared/settings/use-project-trust";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Alert, AlertDescription } from "#/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { TooltipProvider } from "#/components/ui/tooltip";
import { useCloseSessionTab } from "#/hooks/use-close-session-tab";
import { useOrchestrationRuns } from "#/hooks/use-orchestration-runs";
import { readProjectRoots } from "#/hooks/use-project-folders";
import { useProjectKey } from "#/hooks/use-project-key";
import { firstLine } from "#/lib/conversation-format";
import { ipcMessage } from "#/lib/ipc-error";
import {
  conductorTurn,
  lastConductorContext,
  readConductorEnvelope,
  readEnvelope,
} from "#/lib/orchestration-prompt";
import { quoteBlock, quoteOf } from "#/lib/quote";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import {
  conductorConnectors,
  conductorMemory,
  withLiveContext,
} from "#/stores/conductor-context";
import {
  type SentMessage,
  turnsSince,
  useConversationSends,
} from "#/stores/conversation-sends";
import { useNewChats } from "#/stores/new-chats";
import { useSessionTabs } from "#/stores/session-tabs";
import {
  AwaitingProposal,
  LeadRuns,
  OrchestrationPanel,
  orchestrationText,
  RunsAfterTurn,
  useAwaitingProposal,
  useOrchestration,
  useRunsInPlace,
} from "../orchestration/orchestration-panel";
import {
  ConductorSessionsPanel,
  ConductorSessionsToggle,
  PanelGroup,
  PanelSection,
  useSessionsPanel,
} from "./conductor-sessions";
import { useClearConversation } from "./conversation-view.clear";
import {
  drawnTurns,
  useAnchoredTurns,
  useEarlierRuns,
} from "./conversation-view.earlier";
import { HandoffLine, useHandoffLinks } from "./conversation-view.handoff";
import { ManagedNotice } from "./conversation-view.managed";
import { OutdatedNotice, useOutdated } from "./conversation-view.outdated";
import { RollingText } from "./conversation-view.rolling";
import { useStopShortcut } from "./conversation-view.stop";
import { FileOpenerProvider } from "./file-opener";
import { JobCapsules } from "./job-capsules";
import { MessageQueue } from "./message-queue";
import { SelectionActions } from "./selection-actions";
import { TocRail } from "./toc-rail";
import { useConversation } from "./use-conversation";

const ROUTE = "/_app/w/$slug/agents/chat/$conversation" as const;

/**
 * The mark before the chat's title: the title's line height, nudged down a
 * pixel, so it sits on the middle of the lower-case text it leads rather
 * than of the line box.
 */
const TITLE_MARK = "flex h-5 shrink-0 items-center";
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
  const project = useProjectKey(slug);
  const navigate = useNavigate();
  const {
    conversation,
    error,
    engine,
    engineLoaded,
    delta,
    permissions,
    setEngine,
    resync,
    earlier,
    loadingEarlier,
    loadEarlier: loadEarlierPage,
  } = useConversation(project, id);
  // NOTE: A thread is named by its head everywhere (main names its events,
  // its rail row and its limits so); a link to a later session of it (an
  // older handoff's "Continued in", a notification of before) reads the
  // whole thread but hears none of its events. Main's read answers the
  // head's id: the page moves there, in place of this entry.
  // Only a thread's read moves it (its turns carry their session): any
  // other answers the id it was asked, however main spells it.
  const headId =
    conversation?.turns.some((turn) => turn.session) && conversation.id
      ? conversation.id
      : null;
  useEffect(() => {
    if (headId && headId !== id)
      void navigate({
        to: "/w/$slug/agents/chat/$conversation",
        params: { slug, conversation: headId },
        replace: true,
      });
  }, [headId, id, navigate, slug]);
  // The CLI whose conversation it is — Claude Code or Codex — once read.
  const agent = conversation?.agent ?? null;
  // FE-168: its CLI is older than Lanework needs.
  const outdated = useOutdated(conversation?.agent ?? null);
  const label = AGENT_LABELS[agent ?? "claude"];
  useEffect(() => {
    setChatAgent(agent);
    return () => setChatAgent(null);
  }, [agent]);
  // A worker of an orchestration run (FE-87): read-only here, its title bar
  // leads back to the lead's conversation.
  const runs = useOrchestrationRuns(project);
  const asWorker = useMemo(() => {
    for (const run of runs) {
      const task = run.tasks.find((entry) => entry.conversation === id);
      if (task) return { run, task };
    }
    return null;
  }, [runs, id]);
  const leadTitle = useAgentSessions((state) =>
    asWorker && project
      ? state.byProject[project]?.find(
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
  // NOTE: By id alone: a thread's row keeps its head's agent (main folds
  // it so), while `agent` is its newest session's.
  const listed = useAgentSessions((state) =>
    project && agent
      ? state.byProject[project]?.find((entry) => entry.id === id)
      : undefined,
  );
  // NOTE: The agent as known, not a fabricated default: main checks the
  // conversation's id against ITS agent's shape, so a read sent before the
  // transcript lands ("claude" fused with an OpenCode `ses_…` id) is refused
  // (terminal:agent-facts "A valid conversation is required"). The hook
  // skips until the agent is known, then reads with the right pair.
  const facts = useConversationFacts(project, agent, id);

  const [settings, setSettings] = useState<ComposerSettings | null>(null);
  const [renaming, setRenaming] = useState(false);
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
  // The model its last answer came from: what a conversation begun outside
  // the app (OpenCode's TUI) last ran on, when it has no settings here.
  // NOTE: Main's answer when no turn held names one: the read sends the
  // newest turns only (`Conversation.summary`).
  // NOTE: For a thread, its NEWEST session's: the search stops at the last
  // handoff marker, whose target is that session, so an older session's
  // model on another agent never reads as the last run.
  const ranOn = useMemo(() => {
    const turns = conversation?.turns ?? [];
    for (let at = turns.length - 1; at >= 0; at--) {
      const turn = turns[at];
      if (turn?.role === "assistant" && turn.model) return turn.model;
      if (turn?.role === "handoff") return turn.to.model;
    }
    return conversation?.summary?.model ?? null;
  }, [conversation?.turns, conversation?.summary]);
  useEffect(() => {
    if (!loaded || settings || !agent) return;
    // NOTE: A model this CLI cannot run falls to its default, which for
    // OpenCode is none until its list is read: the model it last ran on is
    // kept instead (FE-105).
    const onAgent = (base: ComposerSettings) => {
      const next = settingsFor(agent, base);
      return next.model || !ranOn || agentOfModel(ranOn) !== agent
        ? next
        : { ...next, model: ranOn };
    };
    if (own) {
      setSettings(onAgent(own));
      return;
    }
    let gone = false;
    const surface = window.desktop?.conversation;
    void (surface ? surface.lastSettings() : Promise.resolve(DEFAULT_SETTINGS))
      .catch(() => DEFAULT_SETTINGS)
      .then((last) => {
        if (!gone) setSettings((current) => current ?? onAgent(last));
      });
    return () => {
      gone = true;
    };
  }, [loaded, own, settings, agent, ranOn]);

  const turns = conversation?.turns ?? [];
  // What a send lands as: a user turn; `/compact` as the compaction it asked
  // for (FE-120), as the CLI keeps no turn of the command itself.
  const userTurns = useMemo(
    () =>
      conversation?.turns.filter(
        (turn): turn is UserTurn | CompactionTurn =>
          turn.role === "user" ||
          (turn.role === "compaction" && turn.trigger === "manual"),
      ) ?? [],
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
  } = useProjectTrust(project ?? null);
  const [trustAsk, setTrustAsk] = useState<TrustAsk | null>(null);
  // OpenCode asks no trust question for a folder (FE-104): no banner.
  const untrusted =
    engine.state !== "terminal" &&
    agent !== null &&
    agent !== "opencode" &&
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
              turn.role === "user" &&
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
  // The newest proposal planned before the window main sent, read from its
  // own turns, which are never drawn (`useAnchoredTurns`).
  const { planned, anchored } = useAnchoredTurns(turns, conversation?.summary);
  // `/orchestrate` (FE-87): its planning prompt and proposal JSON stay out of
  // what is drawn; `turns` itself keeps them so sends still match on landing.
  const orchestration = useOrchestration({
    project,
    lead: id,
    // OpenCode never leads (FE-105/D5): no planning turn it would be refused.
    leadAgent: canLead(agent) ? agent : null,
    turns: planned,
    working,
    send: (text, attachments, names) => send(text, attachments, names),
  });
  const shown = useMemo(
    () => drawnTurns(orchestration.turns, anchored),
    [orchestration.turns, anchored],
  );
  // Older proposals' runs: kept in their place, and titled.
  const earlierRuns = useEarlierRuns(orchestration, conversation?.summary);
  // FE-120: what came before the latest compaction is out of the model's
  // context; it stays in the chat, dimmer.
  const compactedBefore = useMemo(() => {
    for (let at = shown.length - 1; at >= 0; at--)
      if (shown[at]?.role === "compaction") return at;
    return -1;
  }, [shown]);
  // What came before it also starts folded away; "Load earlier turns" brings
  // back one compaction's worth at a time. Folded again in another chat.
  // NOTE: One control for both: it unfolds what the page holds first, and
  // once nothing held is folded, reads the page of turns before them from
  // main (the read sends only the newest). A page read is shown whole, its
  // own compactions too (`count` past every fold).
  const compactions = useMemo(
    () => shown.flatMap((turn, at) => (turn.role === "compaction" ? [at] : [])),
    [shown],
  );
  const [unfolded, setUnfolded] = useState({ id, count: 0 });
  const revealed = unfolded.id === id ? unfolded.count : 0;
  /** The first turn drawn: a compaction's divider, or the very first. */
  const firstShown = compactions[compactions.length - 1 - revealed] ?? 0;
  const visible = useMemo(
    () => (firstShown > 0 ? shown.slice(firstShown) : shown),
    [shown, firstShown],
  );
  const awaiting = useAwaitingProposal(orchestration);
  // A settled run, after the reply that proposed it (FE-134).
  const runsInPlace = useRunsInPlace(orchestration);
  // The conductor this conversation belongs to (FE-95), once both the
  // listing (or the start that is ahead of it) and the leads are read.
  const startedFor = useNewChats((state) => state.started[id]?.conductor);
  const conductorId = listed?.conductor ?? startedFor ?? null;
  // Whether the rail's listing of this project has been read: until then a
  // session cannot be told from one a conductor started.
  const listingRead = useAgentSessions((state) =>
    project ? state.byProject[project] !== undefined : false,
  );
  // The conductor that started this session (FE-128), when one did.
  // NOTE: By conductor alone, as its Sessions panel lists them.
  // The rail's row when listed (it follows access changes live), else what
  // main's read said: a session a conductor just started is not listed yet,
  // and its first turn showed the composer.
  const launchedBy = listed?.launchedBy ?? conversation?.launchedBy ?? null;
  const launcherId = launchedBy?.conductor ?? null;
  const launcher =
    !conductorId && launcherId
      ? (orchestration.leads?.find((entry) => entry.id === launcherId) ?? null)
      : null;
  // Read-only, as a worker is, until its conductor lets the user in
  // (`sessions.access`). Main refuses the same calls, so this only keeps
  // controls off the screen that would fail. One whose conductor is gone is
  // the user's again: main says which (`managed`), on the rail's row when
  // it carries the launch, else on its read, by the rule it gates with.
  const managed = !userMayActOn(listed?.launchedBy ? listed : conversation);
  const readOnly = Boolean(asWorker) || managed;
  /**
   * Whether the breadcrumb's place (Sessions, Conductors, which conductor)
   * is known: the conversation read, the listing read, and the team leads
   * read when a conductor is in it.
   *
   * NOTE: Drawn before that, it flashed "Sessions" and then "Conductors".
   */
  const placeKnown =
    conversation !== null &&
    listingRead &&
    (!(conductorId || launcherId) || orchestration.leads !== null);
  const conductor = conductorId
    ? (orchestration.leads?.find((entry) => entry.id === conductorId) ?? null)
    : null;
  // Its Sessions panel (FE-128), open or not as it was left in this chat.
  // Keyed by the route's slug, which is known before the project is.
  const sessionsChat = `${slug}:${id}`;
  const sessionsPanel = useSessionsPanel(sessionsChat);
  // The conductor's own conversation, counted in the panel's overview.
  const conductorSelf = useMemo(
    () =>
      agent ? { agent, id, working: running, session: listed ?? null } : null,
    [agent, id, running, listed],
  );
  // The composer's `/clear`: asks, then resets a conductor's conversation or
  // ends a session for a new one.
  const clearing = useClearConversation({
    slug,
    project,
    id,
    conductor,
    session: listed,
    running,
  });
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
  // Only the turns drawn: a folded one has no place to jump to.
  const entries = useMemo(() => promptLines(visible), [visible]);
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

  /**
   * The distance from the scroller's end when earlier turns were asked for:
   * they go in above, and what was on screen stays where it was.
   */
  const keepFromEnd = useRef<number | null>(null);
  const canLoadEarlier = firstShown > 0 || earlier > 0;
  const loadEarlier = () => {
    if (loadingEarlier) return;
    const node = scroller.current;
    keepFromEnd.current = node ? node.scrollHeight - node.scrollTop : null;
    if (firstShown > 0) {
      setUnfolded({ id, count: revealed + 1 });
      return;
    }
    setUnfolded({ id, count: Number.POSITIVE_INFINITY });
    loadEarlierPage();
  };
  /** The first turn drawn: earlier turns came in when it changes. */
  const topTurn = visible[0]?.id ?? null;
  // NOTE: A page read from main lands a moment after the click: the place
  // is kept once it is in (`loadingEarlier` back to false), not before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again only when earlier turns came in.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (keepFromEnd.current === null || !node || loadingEarlier) return;
    node.scrollTop = node.scrollHeight - keepFromEnd.current;
    keepFromEnd.current = null;
  }, [topTurn, loadingEarlier]);
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
      if (!project) return;
      try {
        await window.desktop?.conversation.answerPermission(
          project,
          id,
          request,
          value,
        );
      } catch (caught) {
        setActionError(ipcMessage(caught, "Could not answer the request."));
      }
    },
    [project, id, setActionError],
  );

  const handlers = useMemo<TurnHandlers>(
    () => ({
      // Forking copies a Claude transcript; Codex's and OpenCode's are not
      // forked here.
      onFork:
        agent === "codex" || agent === "opencode"
          ? undefined
          : () => {
              if (!project || forking) return;
              setForking(true);
              setActionError(null);
              void window.desktop?.conversation
                .fork(project, id)
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
      // A worker has no composer to reply into (FE-91/U18), nor has a
      // session a conductor manages.
      onReply: readOnly
        ? undefined
        : (text) => composer.current?.quote(text, "reply"),
      onAnswer: answer,
      agent: label,
      kind: agent ?? "claude",
    }),
    [
      project,
      id,
      forking,
      navigate,
      slug,
      answer,
      agent,
      label,
      setActionError,
      readOnly,
    ],
  );

  const send = async (
    typed: string,
    attachments: OutgoingAttachment[],
    names: { name: string; image: boolean; size?: number }[],
  ): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!project || !surface || !settings) return false;
    setActionError(null);
    // A conductor's message carries who it is (FE-95), and with its rules
    // what it remembers of the project (FE-128); a planning or repair prompt
    // already names its lead.
    const text =
      conductor &&
      agent &&
      !readEnvelope(typed) &&
      !readConductorEnvelope(typed)
        ? await Promise.all([
            withLiveContext(project, conductor),
            conductorMemory(project, conductor),
            // NOT `conversation.cwd`: that is the agent's last shell
            // directory, which moves whenever it runs `cd` (FE-132).
            readProjectRoots(project),
            conductorConnectors(project, conductor, agent),
          ]).then(([live, memory, roots, connectors]) =>
            conductorTurn(
              typed,
              live,
              agent,
              roots.primary,
              // Main's answer when the window holds no conductor turn.
              lastConductorContext(
                turns,
                conversation?.summary?.conductorContext ?? null,
              ),
              memory,
              roots.others,
              connectors,
            ),
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
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })),
        expect:
          previous.filter((e) => e.expect !== null && !landed(e)).length + 1,
      },
    ]);
    atBottom.current = true;
    requestAnimationFrame(() => toBottom(true));
    // A message sent keeps the chat's tab: it is no preview any more.
    useSessionTabs.getState().open(slug, id);
    try {
      const next = await surface.send({
        project,
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

  /**
   * The agent a `switchAgent` just moved the thread to, until a read of the
   * thread says so: the composer counts the thread as on it meanwhile.
   *
   * NOTE: Without it, a message sent before that read would read as one more
   * handoff, as the picked model is still another agent's than the read's.
   */
  const [switchedTo, setSwitchedTo] = useState<ConversationAgent | null>(null);
  useEffect(() => {
    if (switchedTo && agent === switchedTo) setSwitchedTo(null);
  }, [agent, switchedTo]);

  /**
   * The message continues the thread on the picked model's agent IN PLACE
   * (`switchAgent`): a new native session joins it, the chat stays on this
   * page, and a Context handoff divider marks where.
   */
  const handoff = async ({
    text,
    attachments,
    names,
  }: {
    text: string;
    attachments: OutgoingAttachment[];
    names: { name: string; image: boolean; size?: number }[];
  }): Promise<boolean> => {
    const surface = window.desktop?.conversation;
    if (!project || !surface || !settings) return false;
    setActionError(null);
    const to = agentOfModel(settings.model);
    // NOTE: Main refuses a switch while the newest session runs a turn; said
    // here before anything is sent, and the message stays in the composer.
    if (running) {
      setActionError(
        `${label} is still working. Stop it or wait for its turn to end, then send to hand off to ${AGENT_LABELS[to]}.`,
      );
      return false;
    }
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
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })),
        expect:
          previous.filter((e) => e.expect !== null && !landed(e)).length + 1,
      },
    ]);
    atBottom.current = true;
    requestAnimationFrame(() => toBottom(true));
    try {
      // NOTE: No auto-continue to turn off: an opt-in left on the session
      // the thread moves on from is not the thread's any more (main).
      useSessionTabs.getState().open(slug, id);
      await surface.switchAgent(project, id, {
        model: settings.model,
        effort: settings.effort,
        fast: settings.fast,
        permission: settings.permission,
        text,
        attachments,
      });
      setSwitchedTo(to);
      // NOTE: The new session's first Codex or OpenCode events may have come
      // under its own id, before the thread knew it: read the thread and its
      // engine again rather than wait for the next event.
      resync();
      return true;
    } catch (caught) {
      setSent((previous) => previous.filter((entry) => entry.key !== key));
      setActionError(
        ipcMessage(caught, `Could not hand off to ${AGENT_LABELS[to]}.`),
      );
      return false;
    }
  };
  // Old <-> new, as the handoffs to a NEW conversation recorded them (an
  // older app's): read again as turns land.
  // NOTE: An in-place handoff (`thread`) is drawn by its marker turn among
  // the thread's turns, never as a link to a chat of its own.
  const links = useHandoffLinks(project, id, turns.length);

  const stop = () => {
    if (!project) return;
    void window.desktop?.conversation
      .stop(project, id)
      .catch((caught: unknown) =>
        setActionError(ipcMessage(caught, "Could not stop.")),
      );
  };
  // ⌘W asks, then stops the session: the turn cut off, the agent ended.
  const closeTab = useCloseSessionTab(slug);
  const closeThisTab = useCallback(() => closeTab(id), [closeTab, id]);
  const stopDialog = useStopShortcut({
    label,
    project,
    id,
    running,
    managed,
    onClose: closeThisTab,
  });

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
    if (!project || !surface) return;
    const keys = [...held];
    void unqueue(keys, async () =>
      (await surface.clearQueue(project, id)) ? keys : [],
    ).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not clear the queue.")),
    );
  };

  const removeQueued = (key: string) => {
    const surface = window.desktop?.conversation;
    if (!project || !surface) return;
    void unqueue([key], async () =>
      (await surface.removeQueued(project, id, key)) ? [key] : [],
    ).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not remove it.")),
    );
  };

  /** Back to the composer to be edited; sent again, it queues again (D3). */
  const editQueued = (key: string) => {
    const surface = window.desktop?.conversation;
    if (!project || !surface) return;
    void unqueue([key], async () => {
      const taken = await surface.takeQueued(project, id, key);
      if (!taken) return [];
      composer.current?.restore(unqueued(taken));
      return [key];
    }).catch((caught: unknown) =>
      setActionError(ipcMessage(caught, "Could not edit it.")),
    );
  };

  const resumeQueue = () => {
    if (!project) return;
    void window.desktop?.conversation
      .resumeQueue(project, id)
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
  // A turn on its way with nothing drawn for it yet (no text streaming, no
  // tool running): the chat says it is working rather than standing blank.
  const lastBlock = lastOpen?.blocks[lastOpen.blocks.length - 1];
  const toolRunning =
    lastBlock?.type === "tools" &&
    lastBlock.calls.some((call) => call.output === null);
  const thinking =
    working &&
    !delta &&
    !toolRunning &&
    waiting.length === 0 &&
    asking.length === 0;

  return (
    <TooltipProvider delay={200}>
      <section
        aria-label={`${label} — ${title}`}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        {/* The chat's own header, on the page's card rather than in the
            window's title bar: its mark, its title and the Sessions toggle
            belong to this chat, not to the window. */}
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-2.5 px-5">
          {/* A worker's way back to its lead's conversation: Back, its
              title only in the tooltip, so the worker's own name has the
              bar. */}
          {asWorker && (
            <>
              <button
                type="button"
                onClick={openLead}
                aria-label={`Back to the lead: ${leadTitle ?? "its conversation"}`}
                title={`Back to the lead: ${leadTitle ?? "its conversation"}`}
                className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-[13px] transition-colors"
              >
                <HugeiconsIcon
                  icon={ArrowLeft01Icon}
                  className="size-3.5 shrink-0"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                Back
              </button>
              <span
                aria-hidden="true"
                className="bg-border h-3.5 w-px shrink-0"
              />
            </>
          )}
          {/* A breadcrumb (FE-144): the tabs above say which session, this
              says where it sits. A worker has Back to its lead instead. */}
          {!asWorker && !placeKnown && (
            <Skeleton className="h-4 w-24 shrink-0 rounded" />
          )}
          {!asWorker && placeKnown && (
            <>
              {/* Where it sits in the rail: a conductor's own chat under
                  Conductors, any other under Sessions. */}
              <span className="text-muted-foreground shrink-0 text-[14px] leading-5">
                {conductor || launcher ? "Conductors" : "Sessions"}
              </span>
              <span
                aria-hidden="true"
                className="text-muted-foreground/60 shrink-0 text-[14px] leading-5"
              >
                /
              </span>
              {/* NOTE: A session a conductor started (FE-128) is hidden from
                  the rail: its conductor is the way back, so it is a step of
                  the breadcrumb, not a dead end under Sessions. */}
              {launcher && (
                <>
                  <Link
                    to="/w/$slug/conductors/$lead"
                    params={{ slug, lead: launcher.id }}
                    className="text-muted-foreground hover:text-foreground flex min-w-0 shrink items-center gap-1.5 text-[14px] leading-5 transition-colors"
                  >
                    <ConductorMark
                      lead={launcher}
                      className="size-3.5 shrink-0"
                      strokeWidth={1.5}
                    />
                    <span className="truncate">{launcher.name}</span>
                  </Link>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground/60 shrink-0 text-[14px] leading-5"
                  >
                    /
                  </span>
                </>
              )}
            </>
          )}
          {working ? (
            <span role="img" aria-label="Working" className={TITLE_MARK}>
              <OrbitSpinner className="text-foreground size-3.5" />
            </span>
          ) : conductor ? (
            <span className={TITLE_MARK}>
              <ConductorMark
                lead={conductor}
                className="size-3.5"
                strokeWidth={1.5}
              />
            </span>
          ) : (
            agent && (
              <span className={TITLE_MARK}>
                <TerminalKindIcon kind={agent} className="size-3.5" />
              </span>
            )
          )}
          <h1
            className={cn(
              "min-w-0 truncate text-[14px] leading-5 font-semibold",
              working && "text-shimmer",
            )}
            title={title}
          >
            {title}
          </h1>
          <span className="ml-auto" />
          {/* A conductor's own sessions (FE-128): hidden from the rail, so
              its chat is where they are found, in a panel beside it. */}
          {project && (
            <ConductorSessionsToggle
              project={project}
              conductor={conductor?.id ?? null}
              chat={sessionsChat}
              open={sessionsPanel.open}
              onOpenChange={sessionsPanel.setOpen}
            />
          )}
          <SessionMenu
            slug={slug}
            id={id}
            // Only where the session's name is the title: a conductor's chat
            // shows the conductor's name and a worker's its task's, so a
            // rename there would change nothing on screen.
            onRename={
              listed && project && !conductor && !asWorker
                ? () => setRenaming(true)
                : undefined
            }
          />
        </header>
        {project && (
          <RenameAgentDialog
            project={project}
            session={renaming ? (listed ?? null) : null}
            onClose={() => setRenaming(false)}
          />
        )}

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                  {/* Only once every page is in: before that, its start is
                      only further up. */}
                  {conversation?.truncated && earlier === 0 && (
                    <Alert>
                      <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                      <AlertDescription>
                        This conversation is longer than one read takes: its
                        start is not shown.
                      </AlertDescription>
                    </Alert>
                  )}
                  {!conversation ? (
                    error ? (
                      <Empty className="py-16">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <HugeiconsIcon
                              icon={Alert02Icon}
                              strokeWidth={1.8}
                            />
                          </EmptyMedia>
                          <EmptyTitle>
                            Could not open this conversation
                          </EmptyTitle>
                          <EmptyDescription>{error}</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <ConversationSkeleton label="Reading the conversation" />
                    )
                  ) : turns.length === 0 &&
                    waiting.length === 0 &&
                    !stream &&
                    !thinking ? (
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
                        project={project}
                        conversation={id}
                      >
                        {links.from && !links.from.thread && project && (
                          <HandoffLine
                            slug={slug}
                            project={project}
                            handoff={links.from}
                            side="from"
                          />
                        )}
                        {canLoadEarlier && (
                          <div className="flex w-full min-w-0 items-center gap-3">
                            <span
                              aria-hidden="true"
                              className="bg-border h-px flex-1"
                            />
                            <button
                              type="button"
                              onClick={loadEarlier}
                              disabled={loadingEarlier}
                              aria-busy={loadingEarlier}
                              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 flex h-6 shrink-0 items-center rounded-md px-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none"
                            >
                              {loadingEarlier
                                ? "Loading earlier turns…"
                                : "Load earlier turns"}
                            </button>
                            <span
                              aria-hidden="true"
                              className="bg-border h-px flex-1"
                            />
                          </div>
                        )}
                        {visible.map((turn, index) => (
                          <Fragment key={turn.id}>
                            <TurnView
                              turn={turn}
                              delta={turn === lastOpen ? delta : ""}
                              slug={slug}
                              conversation={id}
                              handlers={handlers}
                              forking={forking}
                              anchor={anchor}
                              compacted={firstShown + index < compactedBefore}
                            />
                            <RunsAfterTurn
                              slug={slug}
                              orchestration={orchestration}
                              placed={runsInPlace.get(turn.id)}
                            />
                          </Fragment>
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
                        {project &&
                          links.to
                            .filter((entry) => !entry.thread)
                            .map((entry) => (
                              <HandoffLine
                                key={`${entry.to.conversation}:${entry.at}`}
                                slug={slug}
                                project={project}
                                handoff={entry}
                                side="to"
                              />
                            ))}
                        {thinking && (
                          <WorkingLine
                            label={
                              engine.state === "starting"
                                ? `Starting ${label}…`
                                : "Working…"
                            }
                            since={lastPromptAt}
                          />
                        )}
                        <OrchestrationPanel
                          slug={slug}
                          orchestration={earlierRuns.panel}
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

            <div>
              <div className="mx-auto flex w-full max-w-[940px] min-w-0 flex-col gap-1.5 px-8 pb-2">
                {(actionError || engine.state === "error") && (
                  <p role="alert" className="text-destructive px-1 text-xs">
                    {actionError ??
                      (engine.state === "error" ? engine.message : null)}
                  </p>
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
                {project && (
                  <JobCapsules
                    slug={slug}
                    project={project}
                    session={listed}
                    since={lastPromptAt}
                    conductor={conductorId}
                  />
                )}
                {/* NOTE: Claude's question stands where the prompt is typed, the
              way the CLI asks it at its own prompt. The composer stays
              mounted under it — hidden, not unmounted — so a draft
              survives. */}
                {/* A proposal waiting for Approve stands here too, above the
              prompt, so it is never scrolled away (FE-95). */}
                {awaiting && !readOnly && (
                  <div className="max-h-[50vh] overflow-y-auto rounded-xl shadow-xs">
                    <AwaitingProposal
                      orchestration={orchestration}
                      proposal={awaiting}
                    />
                  </div>
                )}
                {!readOnly && (
                  <PermissionStack
                    requests={asking}
                    agent={label}
                    onAnswer={answer}
                    project={project}
                    conductor={conductorId}
                  />
                )}
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
                {!asWorker && managed && (
                  <ManagedNotice slug={slug} conductor={launcher} />
                )}
                {project && settings && !readOnly && (
                  <SelectionActions
                    root={content}
                    onAsk={(text, question) => {
                      const quote = quoteOf(text, "mention");
                      if (quote)
                        void send(`${quoteBlock([quote])}${question}`, [], []);
                    }}
                    onMention={(text) =>
                      composer.current?.quote(text, "mention")
                    }
                  />
                )}
                {project && settings && !readOnly && (
                  <div className={asking.length ? "hidden" : "flex flex-col"}>
                    <MessageQueue
                      lead={
                        (untrusted && agent) || outdated ? (
                          <>
                            {untrusted && agent && (
                              <TrustNotice
                                agent={agent}
                                trusting={trusting}
                                onTrust={() => setTrustAsk({ agent, on: true })}
                              />
                            )}
                            {outdated && conversation?.agent && (
                              <div
                                className={
                                  untrusted ? "border-border/60 border-t" : ""
                                }
                              >
                                <OutdatedNotice agent={conversation.agent} />
                              </div>
                            )}
                          </>
                        ) : undefined
                      }
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
                      project={project}
                      agent={switchedTo ?? agent}
                      conversation={id}
                      onHandoff={handoff}
                      settings={settings}
                      onSettings={(next) =>
                        setSettings((previous) =>
                          previous ? { ...previous, ...next } : previous,
                        )
                      }
                      working={running}
                      suspended={asking.length > 0}
                      queued={queue.length}
                      onSend={send}
                      // OpenCode never leads (FE-105/D5): `/orchestrate` goes as typed.
                      onOrchestrate={canLead(agent) ? orchestrate : undefined}
                      onClear={clearing.onClear}
                      onStop={stop}
                      onEditLastQueued={() => {
                        // A queued repair has nothing typed to give back (FE-91).
                        const last = [...queue]
                          .reverse()
                          .find(
                            (item) =>
                              readEnvelope(item.text)?.kind !== "repair",
                          );
                        if (last) editQueued(last.id);
                      }}
                    />
                    {clearing.dialog}
                    {stopDialog}
                  </div>
                )}
              </div>
            </div>
          </div>
          {project && (
            // Its files open in Files, as the chat's file badges do. A chat
            // that is no conductor's gets the panel too, with its own
            // details only.
            <FileOpenerProvider slug={slug} project={project} conversation={id}>
              <ConductorSessionsPanel
                project={project}
                slug={slug}
                conductor={conductor?.id ?? null}
                chat={sessionsChat}
                open={sessionsPanel.open}
                onOpenChange={sessionsPanel.setOpen}
                self={conductorSelf}
                runs={
                  conductor && (
                    <LeadRuns
                      slug={slug}
                      orchestration={earlierRuns.lead}
                      frame={(count, rows) => (
                        <PanelSection>
                          <PanelGroup
                            icon={Flowchart01Icon}
                            label="Runs"
                            count={count}
                            // LeadRuns counts "N running" while one runs, else
                            // a number.
                            live={typeof count === "string"}
                          >
                            {rows}
                          </PanelGroup>
                        </PanelSection>
                      )}
                    />
                  )
                }
              />
            </FileOpenerProvider>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

/**
 * The untrusted-folder notice, the top row of the tab on the composer. Its
 * words go in `title` too, since the row is one truncated line.
 */
function TrustNotice({
  agent,
  trusting,
  onTrust,
}: {
  agent: "claude" | "codex";
  trusting: string | null;
  onTrust: () => void;
}) {
  const text =
    agent === "claude"
      ? "This chat runs without the project’s .claude settings, because Claude Code doesn’t trust this folder."
      : "This chat runs without the project’s .codex config and AGENTS.md, because Codex doesn’t trust this folder.";
  return (
    <div role="status" className="flex h-6 items-center gap-2">
      <HugeiconsIcon
        icon={SecurityCheckIcon}
        className="size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button
        type="button"
        disabled={trusting !== null}
        onClick={onTrust}
        className="hover:bg-foreground/[0.06] hover:text-foreground flex h-6 shrink-0 items-center rounded-md px-1.5 transition-colors disabled:pointer-events-none disabled:opacity-50"
      >
        {trusting === agent ? "Trusting…" : "Trust this folder"}
      </button>
    </div>
  );
}

/**
 * The chat's "still working" line: a turn is running with nothing drawn for
 * it yet. Seconds since the prompt tick beside it, so a long wait reads as
 * alive rather than stuck.
 */
function WorkingLine({
  label,
  since,
}: {
  label: string;
  since: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const from = since ? Date.parse(since) : Number.NaN;
  const seconds = Number.isNaN(from)
    ? null
    : Math.max(0, Math.floor((now - from) / 1000));
  return (
    <div
      role="status"
      className="text-muted-foreground flex items-center gap-2 text-[13px]"
    >
      <OrbitSpinner className="size-[13px]" />
      <span className="text-shimmer">{label}</span>
      {seconds !== null && seconds > 0 && (
        <RollingText text={elapsed(seconds)} />
      )}
    </div>
  );
}

/** `42s`, `3m 05s`. */
function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The header's `…` menu (FE-144): rename the session, copy its id, close its
 * tab. Rename is there once the session is listed (it has a name to change).
 */
function SessionMenu({
  slug,
  id,
  onRename,
}: {
  slug: string;
  id: string;
  onRename?: () => void;
}) {
  const closeTab = useCloseSessionTab(slug);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Session actions"
            title="Session actions"
            className="text-muted-foreground hover:bg-rail-hover hover:text-foreground aria-expanded:bg-rail-hover aria-expanded:text-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              className="size-4"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        {onRename && (
          <DropdownMenuItem onClick={onRename}>Rename…</DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => void navigator.clipboard.writeText(id)}
        >
          Copy session id
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => closeTab(id)}>
          Close tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
