import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  type ConductorStopPreview,
  hasConductorStop,
} from "#/../shared/conductor-sessions";
import type { TeamLead } from "#/../shared/orchestration";
import { StatusPing } from "#/components/shared/agents/status-ping";
import { useTeamLeads } from "#/components/shared/conversation/composer";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
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
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useOpenInTerminal } from "#/hooks/use-open-in-terminal";
import { orderConductors } from "#/lib/conductors";
import { ipcMessage } from "#/lib/ipc-error";
import { leadIcon } from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useChatEngines } from "#/stores/chat-engines";
import { notify } from "#/stores/notify";
import { ConductorDialog, type ConductorDialogMode } from "./conductor-dialog";
import {
  type ConductorState,
  type ConductorStatus,
  useConductorStatuses,
  useConductorStops,
  useFinishedConductors,
} from "./conductor-status";

/**
 * What Stop ends, one short line each, for its dialog: its conversations,
 * the sessions it started, the run it leads.
 */
function stopLines(preview: ConductorStopPreview): string[] {
  const lines: string[] = [];
  const { conversations, sessions, run } = preview;
  if (conversations === 1)
    lines.push(
      preview.answering
        ? "Its conversation (answering now)"
        : "Its conversation",
    );
  else if (conversations > 1)
    lines.push(
      `${conversations} of its conversations${preview.answering ? " (one answering now)" : ""}`,
    );
  if (sessions > 0)
    lines.push(
      `${sessions} ${sessions === 1 ? "session" : "sessions"} it started`,
    );
  if (run)
    lines.push(
      run.workers > 0
        ? `Run "${run.title}" and ${run.workers} working ${run.workers === 1 ? "worker" : "workers"}`
        : `Run "${run.title}"`,
    );
  return lines;
}

function ConductorIcon({
  lead,
  state,
  className,
}: {
  lead: TeamLead;
  state: ConductorState;
  className?: string;
}) {
  return (
    <span className={cn("relative flex shrink-0", className)}>
      <HugeiconsIcon
        icon={leadIcon(lead.icon)}
        className="size-full"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      {/* As a session's: nothing at rest, a dot under the corner else. */}
      {state !== "idle" && (
        <StatusPing
          tone={
            state === "needs-you"
              ? "awaiting"
              : state === "done"
                ? "done"
                : state
          }
        />
      )}
    </span>
  );
}

/**
 * The rail's Conductors (FE-95): every team lead, each with a conversation
 * of its own in this project, as Monocode's Monos have.
 *
 * - A row opens its conductor's conversation, or the composer that starts it.
 * - Its dot says where it stands (`useConductorStatuses`); the tooltip and
 *   the row's label say why.
 * - `+` opens the New conductor dialog; a row's menu (right click, or `⋯`)
 *   edits, copies, makes it the default, or resets its conversation. Reset
 *   only lets the conversation go: it stays, under Agents.
 * - Stop, in the same menu, ends every engine the conductor still runs in
 *   the project, after a dialog that lists them.
 *
 * Draws nothing for a project with no folder here: a conductor's
 * conversation runs in it.
 */
export function ConductorsNav({
  project,
  slug,
  hasFolder,
  row,
  active,
  mini = false,
}: {
  project: string;
  slug: string;
  hasFolder: boolean;
  row: string;
  active: string;
  /** The folded rail: one icon per conductor. */
  mini?: boolean;
}) {
  const navigate = useNavigate();
  const list = useTeamLeads(project, hasFolder);
  const conductors = orderConductors(list);
  const live = useConductorStatuses(project, conductors);
  const finished = useFinishedConductors((state) => state.keys);
  const releaseConductor = useAgentSessions((state) => state.releaseConductor);
  const openInTerminal = useOpenInTerminal(slug, project);
  const [dialog, setDialog] = useState<{
    key: number;
    mode: ConductorDialogMode;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TeamLead | null>(null);
  // Stop always asks first, listing what it ends.
  const [stopping, setStopping] = useState<{
    lead: TeamLead;
    preview: ConductorStopPreview;
  } | null>(null);
  const alive = useChatEngines((state) => state.alive[project]);
  const refreshChats = useChatEngines((state) => state.refresh);
  const loadSessions = useAgentSessions((state) => state.load);
  const { stops, refresh: refreshStops } = useConductorStops(
    project,
    conductors,
  );
  /** Open Stop's dialog, then bring what it lists up to date. */
  const askStop = (lead: TeamLead, preview: ConductorStopPreview) => {
    setStopping({ lead, preview });
    void window.desktop?.conductors
      .stopPreview(project, lead.id)
      .then((fresh) =>
        setStopping((current) =>
          current?.lead.id === lead.id ? { lead, preview: fresh } : current,
        ),
      )
      .catch(() => {});
  };
  /**
   * End every engine a conductor runs here: its conversations, the
   * sessions it started, the run it leads. A turn in progress is cut off;
   * conversations, transcripts and memory are kept, and the next message
   * starts it again. Its row is not under Sessions, so without this a
   * conductor left running could not be stopped from the rail.
   */
  const stopAll = (lead: TeamLead) => {
    const surface = window.desktop?.conductors;
    if (!surface) return;
    void surface
      .stopAll(project, lead.id)
      .then(() => notify("success", `Stopped ${lead.name}`))
      .catch((failure: unknown) =>
        notify("error", `Could not stop ${lead.name}`, {
          description: ipcMessage(failure, "Try again in a moment."),
        }),
      )
      .finally(() => {
        // The switcher's marks and this row read these: clear them now,
        // not on the next event.
        void refreshChats(project);
        void loadSessions(project);
        refreshStops();
      });
  };
  const { lead: viewingLead, conversation: viewing } = useParams({
    strict: false,
  }) as { lead?: string; conversation?: string };
  const isCurrent = (lead: TeamLead, status: ConductorStatus) =>
    viewingLead === lead.id ||
    (status.conversation !== null && viewing === status.conversation);

  // A conductor that stops working while another screen is open keeps a
  // still green dot until it is opened: otherwise the dot just goes out, and
  // work left running in the background is easy to forget.
  const seen = useRef<Record<string, ConductorState>>({});
  useEffect(() => {
    const { mark, clear } = useFinishedConductors.getState();
    for (const lead of conductors) {
      const status = live[lead.id];
      if (!status) continue;
      const key = `${project}:${lead.id}`;
      const was = seen.current[key];
      seen.current[key] = status.state;
      if (isCurrent(lead, status) || status.state !== "idle") clear(key);
      else if (was === "working" || was === "running") mark(key);
    }
  });
  const statuses: Record<string, ConductorStatus> = {};
  for (const [id, status] of Object.entries(live))
    statuses[id] =
      status.state === "idle" && finished.has(`${project}:${id}`)
        ? { ...status, state: "done", reason: "Finished, not opened yet" }
        : // Its engine still runs between turns (the row offers Stop): a
          // still green dot, as a session's (StatusPing `running`).
          status.state === "idle" &&
            status.conversation !== null &&
            alive?.includes(status.conversation)
          ? { ...status, state: "running", reason: "Running, between turns" }
          : status;

  if (!hasFolder || (mini && (!list || conductors.length === 0))) return null;
  // Still reading them: the section's shape, so the rail does not jump.
  if (!list)
    return (
      <nav aria-label="Conductors" className="flex flex-col gap-0.5">
        <div className="flex min-w-0 items-center pt-4 pr-1 pb-1">
          <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
            Conductors
          </span>
        </div>
        <ListSkeleton
          label="Reading the conductors"
          rows={2}
          className="px-0 py-0"
        />
      </nav>
    );

  const open = (lead: TeamLead) =>
    void navigate({
      to: "/w/$slug/conductors/$lead",
      params: { slug, lead: lead.id },
    });
  const openDialog = (mode: ConductorDialogMode) =>
    setDialog({ key: Date.now(), mode });

  const reset = async (lead: TeamLead, status: ConductorStatus) => {
    const session = useAgentSessions
      .getState()
      .byProject[project]?.find((entry) => entry.id === status.conversation);
    if (!session) return;
    try {
      await releaseConductor(project, session);
      setError(null);
      if (viewing === session.id) open(lead);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not reset the conversation."));
    }
  };

  const setDefault = async (lead: TeamLead | null) => {
    try {
      await window.desktop?.leads.setDefault(project, lead?.id ?? null);
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not change the default."));
    }
  };

  /**
   * Delete one of the user's own: its conversation goes back to Agents
   * first, so it is never left hidden under a conductor that is gone.
   */
  const remove = async (lead: TeamLead) => {
    const conversation = statuses[lead.id]?.conversation ?? null;
    const session = conversation
      ? useAgentSessions
          .getState()
          .byProject[project]?.find((entry) => entry.id === conversation)
      : undefined;
    try {
      if (session) await releaseConductor(project, session);
      await window.desktop?.leads.removePersonal(project, lead.id);
      setError(null);
      if (viewingLead === lead.id || (conversation && viewing === conversation))
        void navigate({ to: "/w/$slug/issues", params: { slug } });
    } catch (failure) {
      setError(ipcMessage(failure, "Could not delete the conductor."));
    }
  };

  /**
   * The menu's items, for the context menu and the `⋯` dropdown alike: the
   * conductor itself, then its conversation, then Delete apart.
   */
  const items = (
    lead: TeamLead,
    status: ConductorStatus,
    Item: typeof ContextMenuItem | typeof DropdownMenuItem,
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      {/* A repo's conductor is its file's: copy it to make it yours. */}
      {lead.source === "personal" && (
        <Item onClick={() => openDialog({ kind: "edit", lead })}>Edit</Item>
      )}
      <Item onClick={() => openDialog({ kind: "duplicate", lead })}>
        Duplicate
      </Item>
      <Item
        onClick={() =>
          void setDefault(list.defaultId === lead.id ? null : lead)
        }
      >
        {list.defaultId === lead.id ? "Clear default" : "Set as default"}
      </Item>
      <Separator />
      {/* Its conversation in a terminal, not while it answers (D3). */}
      <Item
        disabled={status.conversation === null || status.state === "working"}
        onClick={() => {
          const session = useAgentSessions
            .getState()
            .byProject[project]?.find(
              (entry) => entry.id === status.conversation,
            );
          if (session)
            void openInTerminal(session).then((failure) => setError(failure));
        }}
      >
        Open in terminal
      </Item>
      <Item
        disabled={status.conversation === null || status.state === "working"}
        onClick={() => void reset(lead, status)}
      >
        Reset conversation
      </Item>
      {/* Whenever it runs anything here, not only its current conversation. */}
      {stops[lead.id] && hasConductorStop(stops[lead.id]) && (
        <Item onClick={() => askStop(lead, stops[lead.id])}>Stop</Item>
      )}
      {lead.source === "personal" && (
        <>
          <Separator />
          <Item
            variant="destructive"
            disabled={status.state === "working"}
            onClick={() => setDeleting(lead)}
          >
            Delete…
          </Item>
        </>
      )}
    </>
  );

  const stopDialog = (
    <AlertDialog
      open={stopping !== null}
      onOpenChange={(open) => !open && setStopping(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop {stopping?.lead.name}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="mb-2 flex list-disc flex-col gap-0.5 ps-4">
              {stopping &&
                stopLines(stopping.preview).map((line) => (
                  <li key={line}>{line}</li>
                ))}
            </ul>
            <p>Conversations are kept; your next message starts it again.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it running</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="border-0"
            onClick={() => {
              const target = stopping;
              setStopping(null);
              if (target) stopAll(target.lead);
            }}
          >
            Stop
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const dialogNode = dialog && (
    <ConductorDialog
      key={dialog.key}
      mode={dialog.mode}
      project={project}
      list={list}
      onClose={() => setDialog(null)}
      onSaved={(input) => {
        setDialog(null);
        if (dialog.mode.kind !== "edit")
          void navigate({
            to: "/w/$slug/conductors/$lead",
            params: { slug, lead: input.id },
          });
      }}
    />
  );

  if (mini)
    return (
      <>
        {conductors.map((lead) => {
          const status = statuses[lead.id] ?? {
            state: "idle",
            reason: "Idle",
            conversation: null,
          };
          return (
            <Tooltip key={lead.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => open(lead)}
                    aria-label={`${lead.name}, ${status.reason.toLowerCase()}`}
                    aria-current={isCurrent(lead, status) ? "page" : undefined}
                    aria-busy={status.state === "working" || undefined}
                    className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] aria-[current]:bg-foreground/[0.08] aria-[current]:text-foreground grid size-9 shrink-0 place-items-center rounded-lg transition-colors duration-150"
                  />
                }
              >
                <ConductorIcon
                  lead={lead}
                  state={status.state}
                  className="size-4"
                />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-56">
                {lead.name}: {status.reason}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {dialogNode}
        {stopDialog}
      </>
    );

  return (
    <nav aria-label="Conductors" className="flex flex-col gap-0.5">
      <div className="flex min-w-0 items-center justify-between gap-2 pt-4 pr-1 pb-1">
        <span className="text-muted-foreground px-2 text-[11px] font-medium tracking-wide uppercase">
          Conductors
        </span>
        {/* Empty, the row below says it; the + comes with the first one. */}
        {conductors.length > 0 && (
          <button
            type="button"
            aria-label="New conductor"
            title="New conductor"
            onClick={() => openDialog({ kind: "new" })}
            className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={Add01Icon}
              className="size-3.5"
              strokeWidth={2}
            />
          </button>
        )}
      </div>
      {conductors.map((lead) => {
        const status = statuses[lead.id] ?? {
          state: "idle" as const,
          reason: "Idle",
          conversation: null,
        };
        const current = isCurrent(lead, status);
        return (
          <div key={lead.id} className="group/row relative">
            <ContextMenu>
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    onClick={() => open(lead)}
                    aria-current={current ? "page" : undefined}
                    aria-label={`${lead.name}, ${status.reason.toLowerCase()}`}
                    aria-busy={status.state === "working" || undefined}
                    title={`${lead.name}\n${status.reason}`}
                    className={`${row} w-full text-left group-focus-within/row:pe-7 group-hover/row:pe-7 ${current ? active : ""}`}
                  />
                }
              >
                <ConductorIcon
                  lead={lead}
                  state={status.state}
                  className="size-3.5"
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    status.state === "working" && "text-shimmer",
                  )}
                >
                  {lead.name}
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-max min-w-40">
                {items(lead, status, ContextMenuItem, ContextMenuSeparator)}
              </ContextMenuContent>
            </ContextMenu>
            <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`More for ${lead.name}`}
                      title="More"
                      className="hover:bg-foreground/[0.06] text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-md transition-colors"
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={MoreHorizontalIcon}
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-max min-w-40">
                  {items(lead, status, DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
      {conductors.length === 0 && (
        <button
          type="button"
          onClick={() => openDialog({ kind: "new" })}
          className={`${row} text-muted-foreground hover:text-foreground w-full text-left`}
        >
          <HugeiconsIcon
            icon={Add01Icon}
            className="size-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">New conductor</span>
        </button>
      )}
      {error && (
        <p role="alert" className="text-destructive px-2 text-xs">
          {error}
        </p>
      )}
      {dialogNode}
      {stopDialog}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from this project. Its conversations stay, under
              Agents, and runs already started under it keep going.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="border-0"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                if (target) void remove(target);
              }}
            >
              Delete conductor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
