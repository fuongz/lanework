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
import { useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";

/**
 * The confirmation in front of throwing a change away (FE-22/D8).
 *
 * NOTE: It says DELETE when that is what will happen. A new file has no
 * earlier version to go back to, so "discard" on it removes the file from
 * disk. A dialog that said "discard changes" there would describe a
 * different, recoverable-sounding act.
 */
export function RestoreDialog({
  files,
  onClose,
}: {
  /** What is about to be restored; null keeps the dialog shut. */
  files: WorktreeFile[] | null;
  onClose: () => void;
}) {
  const restore = useWorktree((state) => state.restore);
  const busy = useWorktree((state) => state.busy);
  const list = files ?? [];
  const deleting = list.filter(
    (file) => file.status === "untracked" || file.status === "added",
  );
  const one = list.length === 1 ? list[0] : null;

  const title = one
    ? deleting.length
      ? `Delete ${one.path}?`
      : `Discard changes to ${one.path}?`
    : `Discard changes to ${list.length} files?`;

  return (
    <AlertDialog
      open={files !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting.length === 0
              ? "The file goes back to how it is in the last commit. This cannot be undone."
              : deleting.length === list.length
                ? `${deleting.length === 1 ? "This file is" : "These files are"} new, so there is no earlier version to go back to — ${deleting.length === 1 ? "it is" : "they are"} deleted from disk. This cannot be undone.`
                : `${deleting.length} of them ${deleting.length === 1 ? "is" : "are"} new and will be deleted from disk; the rest go back to the last commit. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy !== null}>Keep</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy !== null}
            onClick={() => {
              void restore(list.map((file) => file.path)).then(onClose);
            }}
          >
            {deleting.length === list.length ? "Delete" : "Discard"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
