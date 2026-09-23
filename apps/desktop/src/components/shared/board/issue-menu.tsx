import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactElement, type ReactNode, useState } from "react";
import type { BoardCard } from "#/../shared/workspaces";
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
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { useBoard } from "#/stores/board";

/**
 * What a right click on a card offers — on a lane card and on a list row alike.
 *
 * ⚠️ `render` rather than a wrapper element. Both call sites already own their
 * own `<li>`: the list's carries a link, the board's carries dnd-kit's drag
 * listeners AND a layout animation, and neither survives being nested inside a
 * div this component invented. Base UI merges its trigger's handlers into the
 * element it is handed, so the card keeps being the card.
 *
 * ⚠️ The menu names the card it belongs to. On a lane of eight rows the
 * difference between the card you meant and the one under the cursor is one
 * pixel, and the confirmation is the only place that gap can still be caught.
 */
export function IssueMenu({
  card,
  render,
  children,
}: {
  card: BoardCard;
  render: ReactElement;
  children: ReactNode;
}) {
  const stale = useBoard((state) => state.view?.stale ?? false);
  const busy = useBoard((state) => state.busy);
  const [confirming, setConfirming] = useState(false);
  const name = card.taskId ?? card.title;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel>{name}</ContextMenuLabel>
            <ContextMenuItem
              variant="destructive"
              // ⚠️ Off while the board is a saved copy, like every other write.
              // A delete that appeared to work offline would be a card gone
              // from this screen and still on everybody else's.
              disabled={stale || busy === card.id}
              onClick={() => setConfirming(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
              Delete…
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>

      <DeleteIssueDialog
        card={card}
        open={confirming}
        onOpenChange={setConfirming}
      />
    </>
  );
}

/**
 * The confirmation, on its own so two menus can share it.
 *
 * ⚠️ Extracted rather than copied when the detail page grew a `…` button. Two
 * dialogs for one destructive action drift a sentence at a time, and the
 * sentence here is the only place a person is told that nothing in this app can
 * bring the card back.
 */
export function DeleteIssueDialog({
  card,
  open,
  onOpenChange,
}: {
  card: BoardCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const archiveCard = useBoard((state) => state.archiveCard);
  const name = card.taskId ?? card.title;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          {/* ⚠️ It says what actually happens, which is not quite "delete".
                The service archives the card — a tombstone with its own change
                seq, which is how every other machine is told it went — but
                nothing in this app can bring one back, so from here it is gone.
                Promising an undo this app cannot perform would be worse than
                the plain sentence. */}
          <AlertDialogDescription>
            “{card.title}” comes off the board for everyone on this account. The
            service keeps an archived copy, but nothing in this app can restore
            it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            // The registry button pairs `border border-transparent` with
            // `bg-clip-padding`, so the fill stops short of the edge and the
            // popup shows through as a 1px ring — the same `border-0` every
            // other destructive confirmation in this app carries.
            className="border-0"
            onClick={() => {
              onOpenChange(false);
              void archiveCard(card.id);
            }}
          >
            Delete card
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
