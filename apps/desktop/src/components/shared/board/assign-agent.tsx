import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type {
  CardBriefMode,
  TerminalAgent,
  TerminalSession,
} from "#/../shared/terminal";
import type { BoardCard } from "#/../shared/workspaces";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { type ChecklistGate, checklistGate } from "#/lib/checklist-gate";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useBoard } from "#/stores/board";
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
  error: string | null;
}

/**
 * Hand a card to Claude or Codex (FE-34): a NEW agent tab, briefed by the
 * host to work the card end to end.
 *
 * ⚠️ One hook for the header's menu AND the card's right-click menu, so both
 * ask the same question the same way. The dialog it answers is rendered by
 * whoever calls it, next to their own menu.
 *
 * ⚠️ The decisions gate first (AGENTS.md). Settled, the agent starts at once.
 * Open, the dialog says exactly which boxes approving the recommendations
 * would tick (D5a) — and ticks them HERE, in one write, before the agent
 * exists (D4a). The agent is never asked to approve anything itself.
 */
export function useAssignAgent(card: BoardCard) {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const workspace = useWorkspaceKey(slug);
  const navigate = useNavigate();
  const agents = useTerminal((state) => state.agents);
  const loadAgents = useTerminal((state) => state.loadAgents);
  const starting = useAgentTerminals((state) => state.starting);
  const start = useAgentTerminals((state) => state.start);
  const resume = useAgentTerminals((state) => state.resume);
  const columns = useBoard((state) => state.view?.columns);
  const stale = useBoard((state) => state.view?.stale ?? false);
  const readCard = useBoard((state) => state.readCard);
  const approve = useBoard((state) => state.approve);
  const update = useBoard((state) => state.update);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = card.taskId ?? card.id;

  // ⚠️ D8: a card already being worked here is OPENED, never handed out a
  // second time. Its own tab first — the one this app started for it — then
  // any conversation on this machine whose latest MCP call named it (FE-27).
  const tab = useAgentTerminals((state) =>
    workspace
      ? (state.sessions[workspace] ?? []).find(
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
          else if (working?.from === "local" && workspace)
            void resume(workspace, working.session).then(go);
        }
      : null;

  /** Start `agent` on `full`, approving `picks` first. Answers why not. */
  async function run(
    agent: TerminalAgent,
    full: BoardCard,
    mode: CardBriefMode,
    picks: string[],
  ): Promise<string | null> {
    if (!workspace) return "This project is not open here.";
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
    // ⚠️ D2: the agent goes FIRST on the card's agents — `agents[0]` is the
    // dispatch role — and nobody else's assignment is dropped to make room.
    // Best effort: a card that could not be relabelled is still a card the
    // agent can work, and a failed write reports itself on the board.
    const others = current.assignees?.agents ?? [];
    if (others[0] !== agent)
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
    const terminal = await start(workspace, agent, {
      card: current.taskId ?? current.id,
      mode,
    });
    if (!terminal)
      return (
        useAgentTerminals.getState().error ??
        `Could not start ${TERMINAL_KIND_LABELS[agent]}.`
      );
    go(terminal);
    return null;
  }

  /** The menu's click: start now, or ask first. */
  async function assign(agent: TerminalAgent) {
    if (busy) return;
    setBusy(true);
    try {
      // A lane card is a list read, with no checklist to judge.
      const full = card.checklist ? card : await readCard(card.id);
      if (!full?.checklist) return;
      const gate = checklistGate(full.checklist);
      if (gate.ready) {
        const error = await run(agent, full, "work", []);
        if (error) setAsking({ agent, card: full, gate, error });
        return;
      }
      setAsking({ agent, card: full, gate, error: null });
    } finally {
      setBusy(false);
    }
  }

  /** One of the dialog's two ways forward (D4a or D6). */
  async function answer(mode: CardBriefMode) {
    if (!asking || busy) return;
    setBusy(true);
    try {
      const error = await run(
        asking.agent,
        asking.card,
        mode,
        mode === "work" ? asking.gate.picks.map((pick) => pick.key) : [],
      );
      if (error) setAsking({ ...asking, error });
      else setAsking(null);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <AssignAgentDialog
      name={ref}
      asking={asking}
      busy={busy}
      onAnswer={(mode) => void answer(mode)}
      onClose={() => setAsking(null)}
    />
  );

  return {
    /** The agents this machine has, once asked (`load`). */
    agents,
    /** Ask the machine which agents it has: starts the pty host, so lazily. */
    load: () => void loadAgents(),
    /** Nothing can be handed: finished, a saved copy, or mid-start. */
    disabled: closed || stale || !workspace || starting || busy,
    /** Hidden rather than disabled: done or archived. */
    closed,
    openExisting,
    assign: (agent: TerminalAgent) => void assign(agent),
    dialog,
  };
}

/**
 * The confirmation (FE-34/D4a, D5a, D6).
 *
 * ⚠️ It LISTS what approving ticks, box by box, rather than counting. "Approve
 * 4 decisions" is a blank cheque; the keys and their words are what a person
 * is agreeing to.
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
 * card already has one (D8).
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
          // ⚠️ A disabled trigger takes no pointer events, so the tooltip
          // that says why hangs off a wrapper around it.
          <Tooltip>
            <TooltipTrigger render={<span />}>{trigger}</TooltipTrigger>
            <TooltipContent>Save your ticks first</TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
        <DropdownMenuContent align="end" className="min-w-40">
          <AgentItems
            agents={assign.agents}
            onPick={assign.assign}
            Item={DropdownMenuItem}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {assign.dialog}
    </>
  );
}

/**
 * The same choice in a card's right-click menu (FE-34/D1a). Rendered inside
 * `IssueMenu`'s content; `assign` is that menu's `useAssignAgent`.
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

/** One item per agent this machine has — or a line saying there are none. */
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
    return <Item disabled>No Claude or Codex on this machine</Item>;
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
