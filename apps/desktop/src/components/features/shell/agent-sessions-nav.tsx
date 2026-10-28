import { Add01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { AgentSession } from "#/../shared/terminal";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { WorkingMark } from "#/components/shared/terminal/working-mark";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { TooltipProvider } from "#/components/ui/tooltip";
import { ipcMessage } from "#/lib/ipc-error";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { AgentSessionSearch } from "./agent-session-search";
import { AgentSessionsMini } from "./agent-sessions-nav.mini";
import { QuickActions, SessionRow, StopItem } from "./agent-sessions-nav.row";
import { useAgentRail } from "./agent-sessions-nav.sessions";
import { RenameAgentDialog } from "./rename-agent-dialog";

/**
 * Rows before "Show more"; the rest, up to the listing's 20, after it
 * (FE-23/D4).
 */
const FOLDED = 5;

/**
 * The rail's Agents group: the Claude and Codex conversations this project's
 * folder has, newest first.
 *
 * A row opens its agent full size in the main view: the one already resuming
 * it, or a new one.
 *
 * - The rail is the agents' tab list (FE-26/D1). The row whose agent is on
 *   screen is marked the way an active link is, and a new conversation with
 *   no transcript yet still has a row, so it can be got back to.
 * - Three groups, and a row is in exactly one: Running holds the agents whose
 *   pty is alive, Stop in each one's context menu; Pinned the pinned
 *   transcripts; Agents the rest. Running wins over Pinned: a pinned
 *   conversation that is resumed moves up to Running, and back on Stop.
 * - Hidden when there is nothing here to do: no agent CLI on this machine, or
 *   no folder and no conversation (FE-23/D9). A folder with no conversation
 *   yet keeps the group, for its + (FE-26/D3).
 */
export function AgentSessionsNav({
  workspace,
  slug,
  hasFolder,
  row,
  active,
  mini = false,
}: {
  workspace: string;
  slug: string;
  /**
   * The folded rail's form: one icon per agent (running, then pinned, then
   * the most recent idle ones) and no sub-agents.
   */
  mini?: boolean;
  /** Whether this project has a folder here for a new agent to run in. */
  hasFolder: boolean;
  /** The rail's row classes, so these read as its rows. */
  row: string;
  /** The rail's active-row classes. */
  active: string;
}) {
  const rail = useAgentRail(workspace, slug, hasFolder);
  // Its conversations are still being read: the group's shape, so the rail
  // does not jump when they land.
  if (rail.loading && hasFolder && !mini)
    return (
      <nav aria-label="Agents" className="flex flex-col gap-0.5">
        <div className="flex min-w-0 items-center pt-4 pr-1 pb-1">
          <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
            Agents
          </span>
        </div>
        <ListSkeleton
          label="Reading the conversations"
          rows={4}
          className="px-0 py-0"
        />
      </nav>
    );
  if (!rail.visible) return null;
  if (mini)
    return (
      <AgentSessionsMini
        pending={rail.pending}
        fresh={rail.fresh}
        inRunning={rail.inRunning}
        pinned={rail.pinned}
        recent={rail.rest.slice(0, FOLDED)}
        terminalId={rail.terminalId}
        now={rail.now}
        isWorking={rail.isWorking}
        isRunning={rail.isRunning}
        isCurrent={rail.isCurrent}
        openSession={rail.openSession}
        go={rail.go}
      />
    );
  return (
    <AgentSessionsList
      workspace={workspace}
      slug={slug}
      hasFolder={hasFolder}
      row={row}
      active={active}
      rail={rail}
    />
  );
}

/** The full rail's Pinned, Running and Agents groups, and their dialogs. */
function AgentSessionsList({
  workspace,
  slug,
  hasFolder,
  row,
  active: activeClass,
  rail,
}: {
  workspace: string;
  slug: string;
  hasFolder: boolean;
  row: string;
  active: string;
  rail: ReturnType<typeof useAgentRail>;
}) {
  const {
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
    go,
    openSession,
  } = rail;
  const navigate = useNavigate();
  const stop = useAgentTerminals((state) => state.stop);
  const remove = useAgentSessions((state) => state.remove);
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  /** Conversations whose sub-agents are all shown, past the fold (FE-33/D4). */
  const [allSubagents, setAllSubagents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [renaming, setRenaming] = useState<AgentSession | null>(null);
  /** Why an Archive was refused; it has no dialog of its own to show it in. */
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** The conversation whose transcript is about to go for good. */
  const [deleting, setDeleting] = useState<{
    session: AgentSession;
    busy: boolean;
    error: string | null;
  } | null>(null);
  /** The working agent whose Stop asked first (FE-26/D5), as the view does. */
  const [confirming, setConfirming] = useState<{
    stop: () => void;
    label: string;
  } | null>(null);

  const shown = expanded ? rest : rest.slice(0, FOLDED);

  const sessionRow = (session: AgentSession, inPinned = false) => {
    const key = agentKey(session);
    const all = allSubagents.has(key);
    return (
      <SessionRow
        key={key}
        workspace={workspace}
        slug={slug}
        session={session}
        inPinned={inPinned}
        row={row}
        active={activeClass}
        now={now}
        working={rail.isWorking(session)}
        current={rail.isCurrent(session)}
        tab={rail.runningFor(session)}
        chat={rail.chatFor(session)}
        workers={rail.runFor(session)?.tasks}
        allShown={all}
        onToggleAll={() =>
          setAllSubagents((keys) => {
            const next = new Set(keys);
            if (all) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        onResume={() => openSession(session)}
        onRename={() => setRenaming(session)}
        onArchiveError={setArchiveError}
        onDelete={() => setDeleting({ session, busy: false, error: null })}
        onConfirmStop={setConfirming}
      />
    );
  };

  return (
    // One provider for the rail's quick actions. Base UI's own 600ms is longer
    // than a pointer rests on a 20px icon, so the tip would never show; and
    // once one is open, the next (Stop → Pin) opens without waiting.
    <TooltipProvider delay={50}>
      {pinned.length > 0 && (
        <nav aria-label="Pinned" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Pinned
            </span>
          </div>
          {pinned.map((session) => sessionRow(session, true))}
        </nav>
      )}
      {/* The agents running right now (their pty is alive), whether or not
          they are mid-turn: the ones with Stop. Hidden when none is. */}
      {hasRunning && (
        <nav aria-label="Running" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Running
            </span>
          </div>
          {pending.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-current={entry.current ? "page" : undefined}
              aria-label={`Open “${entry.label}”`}
              aria-busy={entry.working || undefined}
              title={`${entry.label}\n${TERMINAL_KIND_LABELS[entry.agent]}, ${entry.working ? "starting" : "new"}`}
              onClick={entry.open}
              className={`${row} w-full text-left ${entry.current ? activeClass : ""}`}
            >
              <TerminalKindIcon
                kind={entry.agent}
                className="size-3 shrink-0"
              />
              <span
                className={`min-w-0 flex-1 truncate ${entry.working ? "text-shimmer" : "text-muted-foreground"}`}
              >
                {entry.label}
              </span>
              {entry.working && <WorkingMark />}
            </button>
          ))}
          {fresh.map((entry) => {
            const agent = TERMINAL_KIND_LABELS[entry.kind];
            const current = entry.id === terminalId;
            return (
              <div key={entry.id} className="group/row relative">
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-current={current ? "page" : undefined}
                        aria-label={`Open new ${agent} session`}
                        onClick={() => go(entry)}
                        className={`${row} w-full text-left ${current ? activeClass : ""} group-hover/row:pe-7 group-focus-within/row:pe-7`}
                      />
                    }
                  >
                    <TerminalKindIcon
                      kind={entry.kind}
                      className="size-3 shrink-0"
                    />
                    <span className="text-muted-foreground min-w-0 flex-1 truncate">
                      New {agent} session
                    </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <StopItem onStop={() => void stop(workspace, entry.id)} />
                  </ContextMenuContent>
                </ContextMenu>
                <QuickActions onStop={() => void stop(workspace, entry.id)} />
              </div>
            );
          })}
          {inRunning.map((session) => sessionRow(session))}
        </nav>
      )}
      {(idle.length > 0 || hasFolder) && (
        <nav aria-label="Agents" className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pb-1 pr-1">
            <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
              Agents
            </span>
            <span className="flex items-center gap-0.5">
              {/* Every conversation by title, past the fold: Claude Code's
                and Codex's in one list. */}
              <button
                type="button"
                aria-label="Search conversations"
                title="Search conversations"
                disabled={sessions.length === 0}
                onClick={() => setSearching(true)}
                className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={Search01Icon}
                  className="size-3.5"
                  strokeWidth={2}
                />
              </button>
              {/* A new conversation opens as a chat: its model picks the CLI,
                Claude Code or Codex, and its composer starts it. */}
              <button
                type="button"
                aria-label="New conversation"
                title="New conversation"
                disabled={!hasFolder}
                onClick={() =>
                  void navigate({
                    to: "/w/$slug/agents/chat/new",
                    params: { slug },
                  })
                }
                className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  className="size-3.5"
                  strokeWidth={2}
                />
              </button>
            </span>
          </div>
          {shown.map((session) => sessionRow(session))}
          {rest.length > FOLDED && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className={`${row} text-muted-foreground w-full text-left text-xs`}
            >
              {expanded ? "Show less" : `Show ${rest.length - FOLDED} more`}
            </button>
          )}
        </nav>
      )}
      <AgentSessionSearch
        open={searching}
        onOpenChange={setSearching}
        sessions={sessions}
        onPick={openSession}
      />
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {confirming?.label} while it is working?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Whatever it is doing now is interrupted. The conversation is kept
              and can be resumed from the Agents group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirming?.stop();
                setConfirming(null);
              }}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !deleting?.busy && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting?.session.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its transcript is deleted from this machine for good. There is no
              undo, and{" "}
              {deleting?.session.agent === "codex"
                ? "codex resume"
                : "claude --resume"}{" "}
              will no longer find it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting?.error && (
            <p role="alert" className="text-destructive text-[13px]">
              {deleting.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting?.busy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting?.busy}
              onClick={(event) => {
                // NOTE: Kept open until main answers, so a refusal is shown
                // here, not lost with a dialog that already closed.
                event.preventDefault();
                if (!deleting) return;
                const { session } = deleting;
                setDeleting({ session, busy: true, error: null });
                remove(workspace, session).then(
                  () => {
                    setDeleting(null);
                    if (viewing === session.id)
                      void navigate({
                        to: "/w/$slug/issues",
                        params: { slug },
                      });
                  },
                  (error: unknown) =>
                    setDeleting({
                      session,
                      busy: false,
                      error: ipcMessage(error, "Could not delete it."),
                    }),
                );
              }}
            >
              {deleting?.busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={archiveError !== null}
        onOpenChange={(open) => !open && setArchiveError(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Could not archive it</AlertDialogTitle>
            <AlertDialogDescription>{archiveError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>OK</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameAgentDialog
        workspace={workspace}
        session={renaming}
        onClose={() => setRenaming(null)}
      />
    </TooltipProvider>
  );
}
