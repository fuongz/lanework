import {
  BubbleChatDownload01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalAgent } from "#/../shared/terminal";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  pullCount,
  pullReads,
  useAgentSessions,
} from "#/stores/agent-sessions";

/** The header's icon buttons, as Search's and New conversation's. */
const ICON_BUTTON =
  "hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50";

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "Claude Code, Codex and OpenCode": the CLIs, by their makers' names. */
function agentNames(agents: TerminalAgent[]): string {
  return LIST.format(agents.map((agent) => HARNESS_NAMES[agent]));
}

/**
 * The rail's Pull (FE-112): what it is doing for `project`, and how to start
 * or stop it.
 *
 * One per Sessions group, so its menu, its empty state and its problem dialog
 * share one answer.
 */
export function useSessionsPull(project: string) {
  const pull = useAgentSessions((state) => state.pull);
  const cancel = useAgentSessions((state) => state.cancelPull);
  /** A Pull runs, of this project or another: one at a time. */
  const busy = useAgentSessions((state) => state.pulling !== null);
  /** That Pull reads this project. */
  const here = useAgentSessions((state) => pullReads(state.pulling, project));
  const cancelling = useAgentSessions(
    (state) => state.pulling?.cancelling ?? false,
  );
  const count = useAgentSessions(
    useShallow((state) => pullCount(state.pulling, project)),
  );
  /** This project's last Pull found nothing: the empty state says so. */
  const foundNone = useAgentSessions(
    (state) =>
      state.lastPull?.project === project &&
      state.lastPull.pulled === 0 &&
      !state.lastPull.error &&
      !state.lastPull.cancelled &&
      state.lastPull.failed.length === 0,
  );
  const [problem, setProblem] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const start = (agents: TerminalAgent[]) =>
    void pull(project, agents).then((end) => {
      if (!end) return;
      if (end.error)
        setProblem({
          title: "Could not pull the sessions",
          description: end.error,
        });
      else if (end.failed.length > 0)
        setProblem({
          title: "Some sessions were not pulled",
          description: `Could not read ${agentNames(end.failed)}’s conversations. The ones it read before stay in Lanework.`,
        });
    });
  return {
    busy,
    here,
    cancelling,
    count,
    foundNone,
    start,
    cancel: () => void cancel(),
    problem,
    clearProblem: () => setProblem(null),
  };
}

type SessionsPull = ReturnType<typeof useSessionsPull>;

/**
 * The header's Pull, in place of its quick actions while one reads this
 * project: how far it has got, and Cancel.
 */
export function PullProgress({ pull }: { pull: SessionsPull }) {
  const { done, total, scanning } = pull.count;
  // `scan` does not know its total yet: a count would read as "0/0".
  const known = total > 0 || !scanning;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        role="progressbar"
        aria-label="Pulling sessions"
        aria-valuemin={0}
        aria-valuemax={known ? total : undefined}
        aria-valuenow={known ? done : undefined}
        aria-valuetext={
          pull.cancelling
            ? "Cancelling"
            : known
              ? `${done} of ${total} read`
              : "Looking for conversations"
        }
        className="text-muted-foreground truncate text-[11px] tabular-nums"
      >
        {pull.cancelling
          ? "Cancelling"
          : known
            ? `Pulling ${done}/${total}`
            : "Pulling"}
      </span>
      <button
        type="button"
        disabled={pull.cancelling}
        onClick={pull.cancel}
        className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground h-5 shrink-0 rounded-md px-1.5 text-[11px] transition-colors disabled:opacity-50"
      >
        Cancel
      </button>
    </span>
  );
}

/**
 * The header's … menu: Pull from each CLI on this machine, or from all of
 * them (FE-112).
 */
export function PullMenu({
  pull,
  agents,
  hasFolder,
}: {
  pull: SessionsPull;
  agents: TerminalAgent[];
  /** A Pull reads the project's folder: none, nothing to read. */
  hasFolder: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Pull sessions"
            title={
              hasFolder ? "Pull sessions" : "This project has no folder here"
            }
            disabled={!hasFolder || agents.length === 0}
            className={ICON_BUTTON}
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              className="size-3.5"
              strokeWidth={2}
            />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto">
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent}
            disabled={pull.busy}
            onClick={() => pull.start([agent])}
          >
            Pull from {HARNESS_NAMES[agent]}
          </DropdownMenuItem>
        ))}
        {agents.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pull.busy}
              onClick={() => pull.start(agents)}
            >
              Pull all
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A project with a folder and no session in Lanework yet (FE-112): what a
 * Pull would bring, and the button that starts it.
 */
export function SessionsEmpty({
  pull,
  agents,
}: {
  pull: SessionsPull;
  agents: TerminalAgent[];
}) {
  const names = agentNames(agents);
  return (
    <Empty className="flex-none gap-3 px-2 py-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={BubbleChatDownload01Icon} strokeWidth={1.8} />
        </EmptyMedia>
        <EmptyTitle>No sessions yet</EmptyTitle>
        <EmptyDescription>
          {pull.foundNone
            ? `${names} had no conversations in this folder. Start one with +.`
            : `Pull the conversations ${names} already had in this folder, or start one with +.`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          disabled={pull.busy}
          onClick={() => pull.start(agents)}
        >
          {pull.here ? "Pulling…" : "Pull sessions"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Why a Pull was refused, or which CLI it could not read. */
export function PullProblemDialog({ pull }: { pull: SessionsPull }) {
  return (
    <AlertDialog
      open={pull.problem !== null}
      onOpenChange={(open) => !open && pull.clearProblem()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pull.problem?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {pull.problem?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>OK</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
