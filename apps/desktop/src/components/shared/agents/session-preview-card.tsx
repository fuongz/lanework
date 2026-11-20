import {
  ArrowDataTransferVerticalIcon,
  Coins01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  agentOfModel,
  type ComposerSettings,
  type Conversation,
  type ConversationAgent,
  EFFORT_LABELS,
  type Effort,
  effortFor,
  type HandoffTurn,
  modelName,
  PERMISSION_COPY,
} from "#/../shared/conversation";
import type { TierModel } from "#/../shared/orchestration";
import type { AgentFacts, AgentSession } from "#/../shared/terminal";
import { handoffAgent } from "#/components/shared/conversation/composer.limit";
import {
  ModelFace,
  PermissionIcon,
} from "#/components/shared/conversation/composer.menus";
import { useModels } from "#/components/shared/conversation/composer.models";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "#/components/ui/preview-card";
import { Skeleton } from "#/components/ui/skeleton";
import { useAgentFacts } from "#/stores/agent-facts";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { COST_NOTE, contextUse } from "./conversation-facts";
import { ContextRing, costText, tokenText } from "./facts";

/** How long a pointer rests on a row before its card opens. */
const OPEN_MS = 500;
/** What a card read this recently is shown again, not read again. */
const FRESH_MS = 15_000;

/** One native session of a conversation (a thread holds several). */
interface NativeSession {
  agent: ConversationAgent;
  conversation: string;
}

/** A model the conversation answered on, with the CLI it ran in. */
interface UsedModel {
  agent: ConversationAgent;
  model: string;
}

/** Tokens in and out and the estimated cost. */
interface Totals {
  tokens: { input: number; output: number } | null;
  costUSD: number | null;
  /** Claude answered again after it last saved its cost. */
  stale: boolean;
  /** How many sessions they add up; 1 for one session's own. */
  sessions: number;
  /** Of those, how many recorded a cost (Codex records none). */
  costed: number;
}

/** What an open card shows, read once per open. */
interface CardRead {
  /** When it was read, epoch ms. */
  at: number;
  /** The session that answers next: a thread's newest, else its own. */
  newest: NativeSession;
  /** What its chat last sent with; null when never sent from chat. */
  settings: ComposerSettings | null;
  /** The model it last answered on, for one never sent from chat. */
  model: string | null;
  /** Every model it answered on, first use first, each once. */
  used: UsedModel[];
  branch: string | null;
  /** The newest session's own facts: its context, model and effort. */
  facts: AgentFacts | null;
  totals: Totals | null;
}

/** By `project|agent:id`. */
const reads = new Map<string, CardRead>();
/** One read in flight per row, shared by every card that asks for it. */
const pending = new Map<string, Promise<CardRead>>();

/** The newest handoff in the window, if one is. */
function lastHandoff(conversation: Conversation): HandoffTurn | null {
  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const turn = conversation.turns[index];
    if (turn?.role === "handoff") return turn;
  }
  return null;
}

/**
 * A thread's sessions, oldest first, from its newest handoff in the window:
 * the sessions it continued, then the one it started. Null without one.
 */
function chainOf(conversation: Conversation): NativeSession[] | null {
  const handoff = lastHandoff(conversation);
  return handoff
    ? [...handoff.from, handoff.to].map(({ agent, conversation: id }) => ({
        agent,
        conversation: id,
      }))
    : null;
}

/** The newest native session, from the turns `read` tagged with theirs. */
function newestSession(conversation: Conversation): NativeSession | null {
  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const session = conversation.turns[index]?.session;
    if (session)
      return { agent: session.agent, conversation: session.conversation };
  }
  return null;
}

/**
 * The model the newest session runs on, read back from the end: an answer
 * before any handoff is its own; a handoff first means it has not answered
 * yet, so the model it was handed to.
 */
function lastModel(conversation: Conversation): string | null {
  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const turn = conversation.turns[index];
    if (turn?.role === "assistant" && turn.model) return turn.model;
    if (turn?.role === "handoff") return turn.to.model;
  }
  return conversation.summary?.model ?? null;
}

/**
 * Every model the conversation answered on, first use first, each once.
 *
 * NOTE: `read` holds a window of the newest turns. The newest handoff names
 * each earlier session's model, so a thread's sessions are all counted; a
 * model one session switched away from before the window is not.
 */
function usedModels(conversation: Conversation): UsedModel[] {
  const out = new Map<string, ConversationAgent>();
  const add = (agent: ConversationAgent, model: string | null) => {
    if (model && !out.has(model)) out.set(model, agent);
  };
  // The sessions the newest handoff continued first, oldest first: some
  // may have ended before the window.
  for (const side of lastHandoff(conversation)?.from ?? [])
    add(side.agent, side.model);
  for (const turn of conversation.turns) {
    if (turn.role === "handoff") {
      for (const side of turn.from) add(side.agent, side.model);
      add(turn.to.agent, turn.to.model);
    } else if (turn.role === "assistant")
      add(turn.session?.agent ?? conversation.agent, turn.model);
  }
  return [...out].map(([model, agent]) => ({ agent, model }));
}

/**
 * Tokens and cost: a thread's summed over its sessions when its chain is
 * known, else the newest session's own.
 *
 * NOTE: Without a handoff in the window the chain's older sessions are not
 * known, so a thread shows its newest session's figures alone. Codex records
 * no cost, so a summed cost covers the sessions that recorded one (`costed`
 * says how many). Tokens are summed only when every session recorded them.
 */
function totalsOf(facts: (AgentFacts | null)[]): Totals | null {
  const newest = facts.at(-1) ?? null;
  const own = (): Totals | null =>
    newest
      ? {
          tokens: newest.tokens,
          costUSD: newest.costUSD,
          stale: newest.stale,
          sessions: 1,
          costed: newest.costUSD === null ? 0 : 1,
        }
      : null;
  if (facts.length < 2) return own();
  const known = facts.filter((entry): entry is AgentFacts => entry !== null);
  if (known.length !== facts.length) return own();
  const costs = known.flatMap((entry) =>
    entry.costUSD === null ? [] : [entry.costUSD],
  );
  const tokens = known.every((entry) => entry.tokens)
    ? known.reduce(
        (sum, entry) => ({
          input: sum.input + (entry.tokens?.input ?? 0),
          output: sum.output + (entry.tokens?.output ?? 0),
        }),
        { input: 0, output: 0 },
      )
    : (newest?.tokens ?? null);
  return {
    tokens,
    costUSD: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    stale: known.some((entry) => entry.stale),
    sessions: known.length,
    costed: costs.length,
  };
}

async function readCard(
  project: string,
  session: AgentSession,
): Promise<CardRead> {
  const terminal = window.desktop?.terminal;
  // Thread-aware: a thread's row id is its head's (the oldest session), and
  // `read` stitches every session after it.
  const conversation =
    (await window.desktop?.conversation
      .read(project, session.id)
      .catch(() => null)) ?? null;
  const chain = conversation ? chainOf(conversation) : null;
  const newest: NativeSession = chain?.at(-1) ??
    (conversation ? newestSession(conversation) : null) ?? {
      agent: conversation?.agent ?? session.agent,
      conversation: session.id,
    };
  const sessions = chain ?? [newest];
  const [workspace, ...facts] = await Promise.all([
    terminal
      ?.agentWorkspace(project, newest.agent, newest.conversation)
      .catch(() => null) ?? null,
    ...sessions.map(
      (entry) =>
        terminal
          ?.agentFacts(project, entry.agent, entry.conversation)
          .catch(() => null) ?? null,
    ),
  ]);
  return {
    at: Date.now(),
    newest,
    settings: conversation?.settings ?? null,
    model: conversation ? lastModel(conversation) : null,
    used: conversation ? usedModels(conversation) : [],
    branch: workspace?.branch ?? conversation?.branch ?? null,
    facts: facts.at(-1) ?? null,
    totals: totalsOf(facts),
  };
}

/** The row's card read: cached when fresh, else read once and shared. */
function cardRead(project: string, session: AgentSession): Promise<CardRead> {
  const key = `${project}|${agentKey(session)}`;
  const known = reads.get(key);
  if (known && Date.now() - known.at < FRESH_MS) return Promise.resolve(known);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const next = readCard(project, session)
    .then((read) => {
      for (const [other, entry] of reads)
        if (read.at - entry.at >= FRESH_MS) reads.delete(other);
      reads.set(key, read);
      return read;
    })
    .finally(() => pending.delete(key));
  pending.set(key, next);
  return next;
}

/**
 * The card's read, from mount: its content mounts only while it is open, so
 * once per open.
 */
function useCardRead(
  project: string,
  session: AgentSession | null,
): CardRead | null {
  const [read, setRead] = useState<CardRead | null>(() => {
    if (!session) return null;
    const known = reads.get(`${project}|${agentKey(session)}`);
    return known && Date.now() - known.at < FRESH_MS ? known : null;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per open, for the row it opened on
  useEffect(() => {
    if (!session) return;
    let live = true;
    void cardRead(project, session).then((answer) => {
      if (live) setRead(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  // The agent view follows its session's facts live: newer than the card's
  // read, they win. Not for a summed thread, whose totals they are not.
  const followed = useAgentFacts((state) =>
    read
      ? state.byKey[
          agentKey({ agent: read.newest.agent, id: read.newest.conversation })
        ]
      : undefined,
  );
  if (!read || !followed || followed.at <= read.at) return read;
  return {
    ...read,
    facts: followed.facts,
    totals:
      (read.totals?.sessions ?? 1) > 1
        ? read.totals
        : totalsOf([followed.facts]),
  };
}

/** Closes the card: a press or a right click on its row. */
const CloseCard = createContext<() => void>(() => {});

/**
 * The row's trigger, for a `render` inside its context menu's trigger.
 *
 * NOTE: A preview card stays open on press, so the row closes it: on a
 * click (it opens the conversation) and on a right click (its menu would
 * open over the card).
 */
export function SessionPreviewTrigger({
  onPointerDown,
  onContextMenu,
  ...props
}: ComponentProps<typeof PreviewCardTrigger>) {
  const close = useContext(CloseCard);
  return (
    <PreviewCardTrigger
      delay={OPEN_MS}
      onPointerDown={(event) => {
        close();
        onPointerDown?.(event);
      }}
      onContextMenu={(event) => {
        close();
        onContextMenu?.(event);
      }}
      {...props}
    />
  );
}

/** The width of a line's icon slot and its gap: what a sub-line indents by. */
const SLOT = "w-3.5";

/** One line of the card: its mark, then its fact, muted. */
function Fact({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <li
      title={title}
      className="text-muted-foreground flex min-w-0 items-start gap-2"
    >
      <span className={`flex h-4 ${SLOT} shrink-0 items-center justify-center`}>
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 leading-4">
        {children}
      </div>
    </li>
  );
}

const mark = (icon: IconSvgElement) => (
  <HugeiconsIcon
    icon={icon}
    className="size-3.5"
    strokeWidth={1.8}
    aria-hidden="true"
  />
);

/** A line still being read: a bar where its text will be. */
const pendingLine = (key: string, width: string) => (
  <li key={key} className="flex items-start gap-2">
    <span className={`h-4 ${SLOT} shrink-0`} />
    <Skeleton className={`mt-0.5 h-3 ${width}`} />
  </li>
);

/**
 * The model, as the composer's pill draws it: its CLI's mark, its name and
 * its effort. A chat's from its settings; else the model it last answered
 * on, and the effort when the CLI wrote one (Codex).
 */
function ModelLine({
  model,
  agent,
  effort,
}: {
  model: string;
  agent: ConversationAgent | null;
  effort: Effort | string | null;
}) {
  // As the composer: a model of another CLI is the one it hands off to.
  const kind = handoffAgent(model, agent) ?? agent ?? agentOfModel(model);
  const label =
    effort && effort in EFFORT_LABELS
      ? EFFORT_LABELS[effortFor(model, effort as Effort)]
      : null;
  return (
    <li className="text-muted-foreground flex min-w-0 items-start gap-2">
      <ModelFace
        kind={kind}
        name={modelName(model) ?? model}
        effort={label}
        iconClassName="my-px size-3.5 shrink-0"
        effortClassName="text-muted-foreground/70"
      />
    </li>
  );
}

function CardBody({
  project,
  title,
  icon,
  session: given,
  conversation,
  defaultModel,
}: SessionPreviewCardProps) {
  // Labels for Codex's and OpenCode's models, as the composer reads them.
  useModels();
  const found = useAgentSessions((state) =>
    conversation
      ? (state.byProject[project]?.find((row) => row.id === conversation) ??
        null)
      : null,
  );
  const session = given ?? found;
  const read = useCardRead(project, session);
  const settings = read?.settings ?? null;
  const model =
    settings?.model ??
    read?.model ??
    read?.facts?.model ??
    defaultModel?.model ??
    null;
  const effort = settings
    ? settings.effort
    : (read?.facts?.effort ?? (read ? null : (defaultModel?.effort ?? null)));
  const agent = read?.newest.agent ?? defaultModel?.agent ?? null;
  const used = read?.used ?? [];
  const showUsed =
    used.length > 1 || (used.length === 1 && used[0]?.model !== model);
  const facts = read?.facts ?? null;
  const use = facts ? contextUse(facts) : null;
  const totals = read?.totals ?? null;
  const loading = session !== null && read === null;
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={`text-muted-foreground flex h-5 ${SLOT} shrink-0 items-center justify-center`}
        >
          {mark(icon)}
        </span>
        <p className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-5 font-semibold break-words">
          {title}
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {loading ? (
          [
            pendingLine("model", "w-28"),
            pendingLine("branch", "w-20"),
            pendingLine("context", "w-24"),
          ]
        ) : (
          <>
            {model && <ModelLine model={model} agent={agent} effort={effort} />}
            {showUsed && (
              <li
                aria-label="Models used"
                className="text-muted-foreground flex flex-wrap gap-x-2.5 gap-y-1 ps-[22px] text-[11px] leading-4"
              >
                {used.map((entry) => (
                  <span
                    key={entry.model}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <TerminalKindIcon
                      kind={entry.agent}
                      className="size-3 shrink-0"
                    />
                    <span className="truncate">
                      {modelName(entry.model) ?? entry.model}
                    </span>
                  </span>
                ))}
              </li>
            )}
            {settings && (
              <Fact
                icon={
                  <PermissionIcon
                    permission={settings.permission}
                    className="size-3.5"
                  />
                }
              >
                <span className="truncate">
                  {PERMISSION_COPY[settings.permission].label}
                </span>
              </Fact>
            )}
            {read?.branch && (
              <Fact icon={mark(GitBranchIcon)}>
                <span className="truncate">{read.branch}</span>
              </Fact>
            )}
            {facts?.context && use && (
              <Fact
                icon={<ContextRing share={use.share} />}
                title={
                  use.guessed
                    ? "The window is taken from the model."
                    : undefined
                }
              >
                {use.share !== null && use.window !== null ? (
                  <>
                    <span className="font-medium">
                      {Math.round(use.share * 100)}%
                    </span>
                    <span>
                      {tokenText(facts.context.tokens)} /{" "}
                      {tokenText(use.window)}
                    </span>
                  </>
                ) : (
                  <span>{tokenText(facts.context.tokens)}</span>
                )}
              </Fact>
            )}
            {totals?.tokens && (
              <Fact
                icon={mark(ArrowDataTransferVerticalIcon)}
                title={
                  totals.sessions > 1
                    ? `Across its ${totals.sessions} sessions`
                    : undefined
                }
              >
                <span>{tokenText(totals.tokens.input)} in</span>
                <span>{tokenText(totals.tokens.output)} out</span>
              </Fact>
            )}
            {totals?.costUSD != null && (
              <Fact
                icon={mark(Coins01Icon)}
                title={
                  totals.sessions > 1
                    ? `${COST_NOTE}\nAcross ${totals.costed} of its ${totals.sessions} sessions: Codex records no cost.`
                    : COST_NOTE
                }
              >
                <span>
                  {costText(totals.costUSD)}
                  {totals.stale ? "+" : ""}
                </span>
              </Fact>
            )}
          </>
        )}
      </ul>
    </>
  );
}

interface SessionPreviewCardProps {
  project: string;
  /** The card's first line, bold. */
  title: string;
  /** The title's mark. */
  icon: IconSvgElement;
  /** The conversation it reads; null before one exists. */
  session?: AgentSession | null;
  /**
   * Or its id, looked up in the rail's sessions only while the card is
   * open, so the row does not redraw with every session's write.
   */
  conversation?: string | null;
  /** The model shown before it has a conversation: a conductor's own. */
  defaultModel?: TierModel;
}

/**
 * A rail row's hover card: the conversation's title, then its model and
 * effort (and every model it used), permission mode, branch, context, tokens
 * and estimated cost.
 *
 * Nothing is read until it opens, and then once per open; a read is reused
 * for {@link FRESH_MS}. The row renders {@link SessionPreviewTrigger}.
 */
export function SessionPreviewCard({
  children,
  ...props
}: SessionPreviewCardProps & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <CloseCard.Provider value={() => setOpen(false)}>
        {children}
      </CloseCard.Provider>
      <PreviewCardContent
        side="right"
        align="start"
        sideOffset={8}
        // A lighter rim and a softer shadow than the popover's default: the
        // card shows on every hover, so it should not shout.
        className="ring-foreground/[0.06] shadow-[0_6px_20px_-6px_rgb(0_0_0/0.14)] dark:ring-foreground/10"
      >
        <CardBody {...props} />
      </PreviewCardContent>
    </PreviewCard>
  );
}
