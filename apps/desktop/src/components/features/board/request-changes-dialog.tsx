import { useEffect, useState } from "react";
import { MAX_CHANGES_REASON } from "#/../shared/projects";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Kbd } from "#/components/ui/kbd";
import { Textarea } from "#/components/ui/textarea";
import { columnOf } from "#/lib/board-view";
import { useBoard } from "#/stores/board";

/** Past this share of the limit the field says how much room is left. */
const COUNT_FROM = 0.8;

/**
 * Ask why a card goes back from Review (FE-118/D3).
 *
 * - Opens on the store's parked `sendBack`, whichever control moved the
 *   card. Cancel (or Esc) drops the move: the card stays in Review.
 * - The reason is required. An empty one cannot be sent, because the agent
 *   that picks the card up reads it as what to change (BE-23).
 * - Enter sends, Shift+Enter is a new line, ⌘↩ sends too. The footer matches
 *   the app's other form dialogs: a ghost Cancel, then the primary action.
 * - Kept open, draft and all, when the move fails: the reason is what someone
 *   just wrote, and the board's error says why it did not save.
 */
export function RequestChangesDialog() {
  const sendBack = useBoard((state) => state.sendBack);
  const cancel = useBoard((state) => state.cancelSendBack);
  const move = useBoard((state) => state.move);
  const view = useBoard((state) => state.view);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // A fresh field for every send-back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per send-back
  useEffect(() => {
    setReason("");
    setFailed(null);
  }, [sendBack?.cardId, sendBack?.columnKey]);

  const card = sendBack
    ? view?.cards.find((entry) => entry.id === sendBack.cardId)
    : undefined;
  const columns = view?.columns ?? [];
  const from = card ? columnOf(columns, card.columnKey)?.name : undefined;
  const to = sendBack ? columnOf(columns, sendBack.columnKey)?.name : undefined;
  const typed = reason.trim();
  const left = MAX_CHANGES_REASON - reason.length;

  const submit = async () => {
    if (!sendBack || !typed || sending) return;
    setSending(true);
    setFailed(null);
    try {
      await move(sendBack.cardId, sendBack.columnKey, typed);
      const { error } = useBoard.getState();
      if (error) setFailed(error);
      else cancel();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={sendBack !== null}
      onOpenChange={(open) => {
        if (!open && !sending) cancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Request changes
              {card?.taskId && (
                <span className="text-muted-foreground ml-1.5 font-mono text-xs font-normal">
                  {card.taskId}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Moves it from {from ?? "review"} back to{" "}
              {to ?? "work in progress"}. The agent that picks it up reads this
              first.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Textarea
              autoFocus
              aria-label="What needs to change"
              placeholder="What needs to change?"
              value={reason}
              maxLength={MAX_CHANGES_REASON}
              disabled={sending}
              rows={4}
              className="max-h-60 min-h-20"
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                // NOTE: Never while an IME is composing. Enter there commits
                // the Vietnamese or Japanese word being typed, and sending the
                // half-typed reason with it loses the rest.
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return;
                if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                void submit();
              }}
            />
            <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
              <span>
                <Kbd>⇧↩</Kbd> new line
              </span>
              {left <= MAX_CHANGES_REASON * (1 - COUNT_FROM) && (
                <span className="ml-auto tabular-nums">{left} left</span>
              )}
            </div>
          </div>
          {failed && (
            <p role="alert" className="text-destructive text-xs">
              {failed}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={sending}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={!typed || sending}>
              {sending ? "Sending…" : "Request changes"}
              {!sending && (
                <Kbd className="ml-1 bg-transparent text-current opacity-70">
                  ↩
                </Kbd>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
