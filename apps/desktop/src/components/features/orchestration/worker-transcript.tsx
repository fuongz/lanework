import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import {
  AGENT_LABELS,
  type Conversation,
  modelName,
  type PermissionRequest,
} from "#/../shared/conversation";
import type { OrchestrationTask } from "#/../shared/orchestration";
import {
  type TurnHandlers,
  TurnView,
} from "#/components/shared/conversation/turn-view";
import { ConversationSkeleton } from "#/components/shared/loading/skeletons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ipcMessage } from "#/lib/ipc-error";
import { visibleTurns } from "#/lib/orchestration-prompt";

const NO_PERMISSIONS: PermissionRequest[] = [];
const noop = () => {};

/**
 * One worker's conversation, read again each time it is written.
 *
 * NOTE: Read-only: no engine is asked for, nothing is sent. The worker is
 * the run's, and only the lead talks to it.
 */
function useWorkerConversation(
  workspace: string,
  id: string | null,
): { conversation: Conversation | null; error: string | null } {
  const [state, setState] = useState<{
    id: string | null;
    conversation: Conversation | null;
    error: string | null;
  }>({ id, conversation: null, error: null });

  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!id || !surface) return;
    let gone = false;
    let reading = false;
    let again = false;
    setState({ id, conversation: null, error: null });
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      surface
        .read(workspace, id)
        .then((conversation) => {
          if (!gone) setState({ id, conversation, error: null });
        })
        .catch((caught: unknown) => {
          if (!gone)
            setState((previous) => ({
              ...previous,
              id,
              error: ipcMessage(caught, "Could not read this worker."),
            }));
        })
        .finally(() => {
          reading = false;
          if (again && !gone) {
            again = false;
            read();
          }
        });
    };
    read();
    const offActivity = window.desktop?.terminal?.onAgentActivity(
      (activity) => {
        if (
          activity.workspace === workspace &&
          activity.id === id &&
          activity.subagent === null
        )
          read();
      },
    );
    const offEvent = surface.onEvent((event) => {
      if (
        event.workspace === workspace &&
        event.conversation === id &&
        (event.type === "turn" || event.type === "moved")
      )
        read();
    });
    return () => {
      gone = true;
      offActivity?.();
      offEvent();
    };
  }, [workspace, id]);

  return state.id === id ? state : { conversation: null, error: null };
}

/** A worker's transcript in a dialog, read-only (FE-87). */
export function WorkerTranscript({
  slug,
  workspace,
  task,
  onClose,
}: {
  slug: string;
  workspace: string;
  /** The worker to show; null: the dialog is closed. */
  task: OrchestrationTask | null;
  onClose: () => void;
}) {
  const id = task?.conversation ?? null;
  const { conversation, error } = useWorkerConversation(workspace, id);
  const handlers = useMemo<TurnHandlers>(
    () => ({
      agent: task ? AGENT_LABELS[task.agent] : undefined,
      onReply: noop,
      onAnswer: async () => {},
    }),
    [task],
  );

  return (
    <Dialog
      open={task !== null && id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        {task && (
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
              <TerminalKindIcon kind={task.agent} className="size-3.5" />
              <span className="truncate">{task.title}</span>
            </DialogTitle>
            <DialogDescription>
              {modelName(task.model) ?? task.model}
              {task.branch ? ` · ${task.branch}` : ""} · read-only: the lead
              talks to this worker.
            </DialogDescription>
          </DialogHeader>
        )}
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-6">
          {conversation && id ? (
            <div className="flex flex-col gap-6 pb-4">
              {visibleTurns(conversation.turns).map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  delta=""
                  permissions={NO_PERMISSIONS}
                  slug={slug}
                  conversation={id}
                  handlers={handlers}
                  forking={false}
                />
              ))}
            </div>
          ) : error ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
                </EmptyMedia>
                <EmptyTitle>Could not open this worker</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ConversationSkeleton label="Reading the worker's transcript" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
