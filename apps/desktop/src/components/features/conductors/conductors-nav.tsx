import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
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
import { ConductorDialog, type ConductorDialogMode } from "./conductor-dialog";
import {
  type ConductorState,
  type ConductorStatus,
  useConductorStatuses,
} from "./conductor-status";

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
      {/* As a session's: nothing at rest, a ping under the corner else. */}
      {state !== "idle" && (
        <StatusPing tone={state === "working" ? "working" : "awaiting"} />
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
  const statuses = useConductorStatuses(project, conductors);
  const releaseConductor = useAgentSessions((state) => state.releaseConductor);
  const openInTerminal = useOpenInTerminal(slug, project);
  const [dialog, setDialog] = useState<{
    key: number;
    mode: ConductorDialogMode;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TeamLead | null>(null);
  const { lead: viewingLead, conversation: viewing } = useParams({
    strict: false,
  }) as { lead?: string; conversation?: string };

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
  const isCurrent = (lead: TeamLead, status: ConductorStatus) =>
    viewingLead === lead.id ||
    (status.conversation !== null && viewing === status.conversation);
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
