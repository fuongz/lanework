import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  AUTONOMY_COPY,
  AUTONOMY_LEVELS,
  type AutonomyKnobs,
  type AutonomyLevel,
  type AutonomySettings,
  effectiveKnobs,
  isAutonomyLevel,
  isCustom,
  LEVEL_KNOBS,
  permissionInFolder,
} from "#/../shared/autonomy";
import { DEFAULT_SETTINGS, settingsFor } from "#/../shared/conversation";
import type { BoardCard } from "#/../shared/projects";
import {
  type CardAutonomy,
  type CardBriefMode,
  cardPrompt,
  isBoardId,
  type TerminalAgent,
  type TerminalSession,
} from "#/../shared/terminal";
import { useCardAgents } from "#/components/shared/board/card-agents";
import { InlineMarkdown } from "#/components/shared/common/markdown-body";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { ContextMenuItem } from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useProjectKey } from "#/hooks/use-project-key";
import { type ChecklistGate, checklistGate } from "#/lib/checklist-gate";
import { ipcMessage } from "#/lib/ipc-error";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useProjectAutonomy } from "#/stores/autonomy";
import { useBoard } from "#/stores/board";
import { handSentMessage } from "#/stores/conversation-sends";
import { useNewChats } from "#/stores/new-chats";
import { useSessionTabs } from "#/stores/session-tabs";
import { useTerminal } from "#/stores/terminal";

/** The lanes a card is over in: nobody is handed finished or archived work. */
const CLOSED_ROLES = new Set(["done", "archive"]);

/** Today, the way every dated note on the board reads: `2026-10-01`. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What the dialog is asking about: one card, for one agent. */
interface Asking {
  agent: TerminalAgent;
  card: BoardCard;
  gate: ChecklistGate;
  /** The dial's knobs chosen when it was asked; absent with no dial. */
  knobs: AutonomyKnobs | undefined;
  error: string | null;
}

/**
 * The trust question before an agent starts (FE-173): its CLI does not trust
 * the project's folder yet.
 */
interface TrustAsk {
  agent: "claude" | "codex";
  error: string | null;
}

/** What trusting loads, in the words the chat's own notice uses. */
const TRUST_LOADS: Record<TrustAsk["agent"], string> = {
  claude: "the project’s .claude settings",
  codex: "the project’s .codex config and AGENTS.md",
};

/** "This assignment follows no dial", in the level menu (PD-08). */
const NO_DIAL = "none";
type AutonomyChoice = AutonomyLevel | typeof NO_DIAL;

/**
 * The knobs an assignment runs with (PD-08/W2).
 *
 * The project's own level keeps the knobs turned by hand there; another
 * level is that level as it comes.
 *
 * @param choice Picked for this assignment; undefined follows the project.
 * @returns Undefined when no dial applies: the flow is the one without it.
 */
function knobsFor(
  dial: AutonomySettings | null | undefined,
  choice: AutonomyChoice | undefined,
): AutonomyKnobs | undefined {
  if (choice === NO_DIAL) return undefined;
  if (choice === undefined || choice === dial?.level)
    return dial ? effectiveKnobs(dial) : undefined;
  return LEVEL_KNOBS[choice];
}

/** What the card brief carries of the knobs: the host's part. */
function briefAutonomy(
  knobs: AutonomyKnobs | undefined,
): CardAutonomy | undefined {
  return knobs
    ? {
        permission: knobs.permission,
        commit: knobs.commit,
        toReview: knobs.toReview,
      }
    : undefined;
}

/**
 * Hand a card to Claude, Codex or OpenCode: a new chat conversation, its
 * first message the card prompt (FE-173). It used to open a terminal tab
 * (FE-34), which stalled on the CLI's own trust screen in a folder it did
 * not trust yet; the chat engine runs there with the user's settings only,
 * and the trust question is asked here first.
 *
 * - One hook for the header's menu and the card's right-click menu, so both
 *   ask the same question the same way. The caller renders the dialog it
 *   returns, next to its own menu.
 * - The decisions gate first (`AGENTS.md`). Settled, the agent starts at
 *   once. Open, the dialog says which boxes approving the recommendations
 *   would tick (FE-34/D5a), and ticks them here, in one write, before the
 *   agent exists (FE-34/D4a). The agent is never asked to approve anything
 *   itself.
 */
export function useAssignAgent(card: BoardCard) {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const project = useProjectKey(slug);
  const navigate = useNavigate();
  const agents = useTerminal((state) => state.agents);
  const loadAgents = useTerminal((state) => state.loadAgents);
  const starting = useAgentTerminals((state) => state.starting);
  const resume = useAgentTerminals((state) => state.resume);
  const columns = useBoard((state) => state.view?.columns);
  const stale = useBoard((state) => state.view?.stale ?? false);
  const readCard = useBoard((state) => state.readCard);
  const approve = useBoard((state) => state.approve);
  const update = useBoard((state) => state.update);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [trustAsk, setTrustAsk] = useState<TrustAsk | null>(null);
  // The project's dial (PD-08), and a level picked for this assignment only.
  const dial = useProjectAutonomy(slug);
  const [choice, setChoice] = useState<AutonomyChoice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const ref = card.taskId ?? card.id;

  // A card already being worked here is opened, never handed out a second
  // time (FE-34/D8). Its own tab first (the one this app started for it), then
  // any conversation on this machine whose latest MCP call named it.
  const tab = useAgentTerminals((state) =>
    project
      ? (state.sessions[project] ?? []).find(
          (entry) =>
            !entry.exit &&
            entry.card !== null &&
            (entry.card === card.id ||
              entry.card.toUpperCase() === card.taskId?.toUpperCase()),
        )
      : undefined,
  );
  const working = useCardAgents(card).find((agent) => agent.from === "local");

  const role = columns?.find((column) => column.key === card.columnKey)?.role;
  const closed = role != null && CLOSED_ROLES.has(role);

  const go = (terminal: TerminalSession | null) => {
    if (terminal && slug)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: terminal.id },
      });
  };

  const openExisting =
    tab || working?.from === "local"
      ? () => {
          if (tab) go(tab);
          else if (working?.from === "local" && project)
            void resume(project, working.session).then(go);
        }
      : null;

  /** Start `agent` on `full`, approving `picks` first. Answers why not. */
  async function run(
    agent: TerminalAgent,
    full: BoardCard,
    mode: CardBriefMode,
    picks: string[],
    knobs: AutonomyKnobs | undefined,
  ): Promise<string | null> {
    if (!project) return "This project is not open here.";
    let current = full;
    if (picks.length) {
      const approved = await approve(
        current,
        picks,
        `Approved as recommended from the desktop app on ${today()}`,
      );
      if (!approved)
        return (
          useBoard.getState().error ??
          "The card changed before the approvals saved. Look again."
        );
      current = approved;
    }
    // The agent goes first on the card's agents, since `agents[0]` is the
    // dispatch role, and nobody else's assignment is dropped to make room
    // (FE-34/D2). Best effort: a card that could not be relabelled is still a
    // card the agent can work, and a failed write reports itself on the board.
    const others = current.assignees?.agents ?? [];
    // NOTE: A local board refuses assignees (cloud-only, FE-52/D10). Asking
    // anyway only showed "Assigning is only on cloud boards" over an agent
    // that started fine, so a local board skips the label.
    const local = useBoard.getState().active?.origin === "local";
    if (!local && others[0] !== agent)
      await update(
        current.id,
        {
          assignees: {
            users: current.assignees?.users ?? [],
            agents: [agent, ...others.filter((entry) => entry !== agent)],
          },
        },
        current.revision,
      );
    return startChat(agent, current, mode, knobs);
  }

  /**
   * Open a chat for `current` on `agent`: the card prompt as its first
   * message, in the dial's permission when one applies (FE-173, PD-08).
   *
   * NOTE: The same steps as the New chat page's send, so the rail lists it
   * at once and the first message shows before the CLI writes it down.
   */
  async function startChat(
    agent: TerminalAgent,
    current: BoardCard,
    mode: CardBriefMode,
    knobs: AutonomyKnobs | undefined,
  ): Promise<string | null> {
    const surface = window.desktop?.conversation;
    const boardId = useBoard.getState().active?.id;
    if (!project || !slug || !surface) return "This project is not open here.";
    if (!isBoardId(boardId))
      return "This project has no board to take a card from.";
    const last = await surface.lastSettings().catch(() => DEFAULT_SETTINGS);
    const base = settingsFor(agent, last);
    const wanted = knobs?.permission ?? base.permission;
    // FE-173/D3: read again here, after any Trust and start. A folder the
    // CLI does not trust (or a read that fails) starts Supervised; OpenCode
    // keeps no folder trust.
    const trusted =
      agent === "opencode"
        ? true
        : await window.desktop?.agentSetup
            .trust(slug)
            .then((found) => found[agent].trusted)
            .catch(() => false);
    const settings = {
      ...base,
      permission: permissionInFolder(wanted, trusted ?? false),
    };
    const text = cardPrompt(
      mode,
      boardId,
      current.taskId ?? current.id,
      briefAutonomy(knobs),
    );
    const { begin, end } = useNewChats.getState();
    begin({ project, agent, text });
    try {
      const { conversation } = await surface.start({
        project,
        text,
        attachments: [],
        settings,
      });
      end(project, conversation);
      useSessionTabs.getState().open(slug, conversation);
      handSentMessage(JSON.stringify([slug, conversation]), {
        key: "first",
        since: null,
        expect: 1,
        text,
        attachments: [],
      });
      void navigate({
        to: "/w/$slug/agents/chat/$conversation",
        params: { slug, conversation },
      });
      return null;
    } catch (caught) {
      end(project, null);
      return ipcMessage(
        caught,
        `Could not start ${TERMINAL_KIND_LABELS[agent]}.`,
      );
    }
  }

  /**
   * The menu's click: ask about trust when the agent's CLI does not trust
   * the folder yet (FE-173), then go on.
   *
   * NOTE: Lanework never trusts a folder by itself (FE-77/D3): trusting runs
   * the repository's own settings as the user. A read that fails goes on as
   * before; the chat then shows its own trust notice.
   */
  async function assign(agent: TerminalAgent) {
    if (busy) return;
    if (slug && (agent === "claude" || agent === "codex")) {
      const setup = window.desktop?.agentSetup;
      const trust = await setup?.trust(slug).catch(() => null);
      if (trust?.folder && !trust[agent].trusted) {
        setTrustAsk({ agent, error: null });
        return;
      }
    }
    await proceed(agent);
  }

  /** The trust question's answer: trust first, or go on without it. */
  async function answerTrust(trust: boolean) {
    if (!trustAsk || busy) return;
    const { agent } = trustAsk;
    if (trust && slug) {
      setBusy(true);
      try {
        await window.desktop?.agentSetup.setTrust(slug, agent, true);
      } catch (caught) {
        setTrustAsk({
          agent,
          error: ipcMessage(caught, "Could not trust this folder."),
        });
        return;
      } finally {
        setBusy(false);
      }
    }
    setTrustAsk(null);
    await proceed(agent);
  }

  /** Start now, or ask about the card's open decisions first. */
  async function proceed(agent: TerminalAgent) {
    if (busy) return;
    setBusy(true);
    try {
      // A lane card is a list read, with no checklist to judge.
      const full = card.checklist ? card : await readCard(card.id);
      if (!full?.checklist) return;
      const gate = checklistGate(full.checklist);
      const knobs = knobsFor(dial, choice);
      // The dial approves the recommendations for you: what the dialog's
      // "Approve and start" does, without the dialog (PD-08). A decision
      // with no recommendation still asks.
      const approveAll =
        !gate.ready && knobs?.autoApprove && !gate.blocked.length;
      if (gate.ready || approveAll) {
        const picks = approveAll ? gate.picks.map((pick) => pick.key) : [];
        const error = await run(agent, full, "work", picks, knobs);
        if (error) setAsking({ agent, card: full, gate, knobs, error });
        return;
      }
      setAsking({ agent, card: full, gate, knobs, error: null });
    } finally {
      setBusy(false);
    }
  }

  /** One of the dialog's two ways forward (FE-34/D4a or D6). */
  async function answer(mode: CardBriefMode) {
    if (!asking || busy) return;
    setBusy(true);
    try {
      const error = await run(
        asking.agent,
        asking.card,
        mode,
        mode === "work" ? asking.gate.picks.map((pick) => pick.key) : [],
        asking.knobs,
      );
      if (error) setAsking({ ...asking, error });
      else setAsking(null);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <>
      <AssignAgentDialog
        name={ref}
        asking={asking}
        busy={busy}
        onAnswer={(mode) => void answer(mode)}
        onClose={() => setAsking(null)}
      />
      <TrustFolderDialog
        ask={trustAsk}
        busy={busy}
        onAnswer={(trust) => void answerTrust(trust)}
        onClose={() => setTrustAsk(null)}
      />
    </>
  );

  return {
    /** The agents this machine has, once asked (`load`). */
    agents,
    /** Ask the machine which agents it has: starts the pty host, so lazily. */
    load: () => void loadAgents(),
    /** Nothing can be handed: finished, a saved copy, or mid-start. */
    disabled: closed || stale || !project || starting || busy,
    /** Hidden rather than disabled: done or archived. */
    closed,
    openExisting,
    assign: (agent: TerminalAgent) => void assign(agent),
    /**
     * The level this assignment runs at: picked here, else the project's,
     * else none. Undefined while the project's dial is read.
     */
    level:
      choice ?? (dial === undefined ? undefined : (dial?.level ?? NO_DIAL)),
    /** The project's dial, for the menu to say which level is its own. */
    dial,
    pickLevel: setChoice,
    dialog,
  };
}

/**
 * The trust question before an agent starts in a folder its CLI does not
 * trust yet (FE-173). Trusting writes the CLI's own record (FE-101), the one
 * its trust screen writes.
 */
function TrustFolderDialog({
  ask,
  busy,
  onAnswer,
  onClose,
}: {
  ask: TrustAsk | null;
  busy: boolean;
  onAnswer: (trust: boolean) => void;
  onClose: () => void;
}) {
  const agent = ask ? TERMINAL_KIND_LABELS[ask.agent] : "";
  return (
    <AlertDialog
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Trust this folder for {agent}?</AlertDialogTitle>
          <AlertDialogDescription>
            {ask
              ? `${agent} doesn’t trust this project’s folder yet. Trusting it lets ${agent} load ${TRUST_LOADS[ask.agent]}, which can run commands as you. Without it, the chat runs with your own settings only, and in Supervised mode: ${agent} asks before every command and edit.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {ask?.error && (
          <p role="alert" className="text-destructive text-[13px]">
            {ask.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onAnswer(false)}
          >
            Start without trusting
          </Button>
          <Button disabled={busy} onClick={() => onAnswer(true)}>
            {busy ? "Trusting…" : "Trust and start"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The confirmation before an agent starts (FE-34/D4a, D5a, D6).
 *
 * It lists what approving ticks, box by box, rather than counting. "Approve 4
 * decisions" is a blank cheque; the keys and their words are what a person is
 * agreeing to.
 */
function AssignAgentDialog({
  name,
  asking,
  busy,
  onAnswer,
  onClose,
}: {
  name: string;
  asking: Asking | null;
  busy: boolean;
  onAnswer: (mode: CardBriefMode) => void;
  onClose: () => void;
}) {
  const agent = asking ? TERMINAL_KIND_LABELS[asking.agent] : "";
  const gate = asking?.gate;
  const blocked = gate?.blocked ?? [];
  const picks = gate?.picks ?? [];
  return (
    <AlertDialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Hand {name} to {agent}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {gate?.ready
              ? `${agent} could not start on ${name}.`
              : blocked.length
                ? `${blocked.join(", ")} ${blocked.length === 1 ? "has" : "have"} no recommended option, so nothing can be approved for you. Pick on the card, or have ${agent} review the open decisions with you first.`
                : `${picks.length === 1 ? "One decision is" : `${picks.length} decisions are`} still open. Approve the recommended ${picks.length === 1 ? "option" : "options"} and ${agent} starts on the card straight away:`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!gate?.ready && !blocked.length && picks.length > 0 && (
          <ul
            aria-label="Approved if you continue"
            className="flex max-h-64 flex-col gap-1.5 overflow-y-auto text-[13px] leading-relaxed"
          >
            {picks.map((pick) => (
              <li key={pick.key} data-pick={pick.key}>
                <span className="text-muted-foreground mr-1.5 font-mono text-xs">
                  {pick.key}
                </span>
                <InlineMarkdown source={pick.text} />
              </li>
            ))}
          </ul>
        )}
        {asking?.error && (
          <p role="alert" className="text-destructive text-[13px]">
            {asking.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {!gate?.ready && (
            <Button
              variant={blocked.length ? "default" : "outline"}
              disabled={busy}
              onClick={() => onAnswer("review")}
            >
              Review in session
            </Button>
          )}
          {(gate?.ready || !blocked.length) && (
            <Button disabled={busy} onClick={() => onAnswer("work")}>
              {busy
                ? "Starting…"
                : gate?.ready
                  ? "Try again"
                  : "Approve and start"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Issue detail's "Assign to agent ▾" (FE-34/D1a), or "Open session" when the
 * card already has one (FE-34/D8).
 */
export function AssignAgentButton({
  card,
  unsaved,
}: {
  card: BoardCard;
  /** Ticks on screen that are not saved: the gate would judge the old card. */
  unsaved: boolean;
}) {
  const assign = useAssignAgent(card);
  if (assign.closed) return null;
  if (assign.openExisting)
    return (
      <Button variant="ghost" size="sm" onClick={assign.openExisting}>
        Open session
      </Button>
    );
  const trigger = (
    <DropdownMenuTrigger
      disabled={assign.disabled || unsaved}
      render={<Button variant="ghost" size="sm" className="gap-1" />}
    >
      Assign to agent
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        className="text-muted-foreground size-3.5"
        strokeWidth={2}
      />
    </DropdownMenuTrigger>
  );
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) assign.load();
        }}
      >
        {unsaved ? (
          // A disabled trigger takes no pointer events, so the tooltip that
          // says why hangs off a wrapper around it.
          <Tooltip>
            <TooltipTrigger render={<span />}>{trigger}</TooltipTrigger>
            <TooltipContent>Saving your ticks…</TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
        <DropdownMenuContent align="end" className="min-w-48">
          <AgentItems
            agents={assign.agents}
            onPick={assign.assign}
            Item={DropdownMenuItem}
          />
          <LevelItems
            level={assign.level}
            dial={assign.dial}
            onPick={assign.pickLevel}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {assign.dialog}
    </>
  );
}

/**
 * The same choice in a card's right-click menu (FE-34/D1a).
 *
 * Rendered inside {@link IssueMenu}'s content; `assign` is that menu's
 * {@link useAssignAgent}.
 */
export function AssignAgentMenuItems({
  assign,
}: {
  assign: ReturnType<typeof useAssignAgent>;
}) {
  if (assign.closed) return null;
  if (assign.openExisting)
    return (
      <ContextMenuItem onClick={assign.openExisting}>
        Open session
      </ContextMenuItem>
    );
  return (
    <AgentItems
      agents={assign.agents}
      disabled={assign.disabled}
      onPick={assign.assign}
      Item={ContextMenuItem}
      icons={false}
      label={(agent) => `Assign to ${agent}`}
    />
  );
}

/**
 * The autonomy level for this one assignment (PD-08/W2), under the agents:
 * the project's own is picked to begin with, or "Not set" when it has none.
 */
function LevelItems({
  level,
  dial,
  onPick,
}: {
  level: AutonomyChoice | undefined;
  dial: AutonomySettings | null | undefined;
  onPick: (choice: AutonomyChoice) => void;
}) {
  const own = (entry: AutonomyLevel) =>
    dial?.level === entry ? (isCustom(dial) ? "Custom" : "Project") : null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Autonomy</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={level ?? null}
          onValueChange={(next: string) => {
            if (next === NO_DIAL || isAutonomyLevel(next)) onPick(next);
          }}
        >
          <DropdownMenuRadioItem value={NO_DIAL} className="text-[13px]">
            Not set
          </DropdownMenuRadioItem>
          {AUTONOMY_LEVELS.map((entry) => (
            <DropdownMenuRadioItem
              key={entry}
              value={entry}
              className="text-[13px]"
            >
              {AUTONOMY_COPY[entry].label}
              {own(entry) && (
                <span className="text-muted-foreground ml-auto text-xs">
                  {own(entry)}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </>
  );
}

/** One item per agent this machine has, or a line saying there are none. */
function AgentItems({
  agents,
  disabled = false,
  onPick,
  Item,
  icons = true,
  label = (agent) => agent,
}: {
  agents: TerminalAgent[];
  disabled?: boolean;
  onPick: (agent: TerminalAgent) => void;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  /** The agent's mark before its name; a context menu is text only. */
  icons?: boolean;
  label?: (agent: string) => string;
}) {
  if (agents.length === 0)
    return <Item disabled>No coding agent on this machine</Item>;
  return agents.map((agent) => (
    <Item
      key={agent}
      className="text-[13px]"
      disabled={disabled}
      onClick={() => onPick(agent)}
    >
      {icons && <TerminalKindIcon kind={agent} className="size-4 shrink-0" />}
      {label(TERMINAL_KIND_LABELS[agent])}
    </Item>
  ));
}
