import { useEffect, useState } from "react";
import type { ReadinessCheck } from "#/../shared/readiness";
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
import { useReadiness } from "#/stores/readiness";

/**
 * Link the folder's repo to this project's board, confirmed first (BE-20/D3):
 * from another board it is a MOVE — new cards come here, the old board keeps
 * the ones it has. When this board is itself on a different repo, the service
 * refuses, and the dialog asks once more, naming that repo (D2).
 *
 * ⚠️ The caller's, outside any popover, like the Fix dialog: a click in it
 * would otherwise close the popover and unmount it mid-request.
 */
export function ReadinessLinkDialog({
  slug,
  check,
  onOpenChange,
}: {
  slug: string;
  /** The `board` check to act on; null keeps the dialog shut. */
  check: ReadinessCheck | null;
  onOpenChange: (open: boolean) => void;
}) {
  const linkBoard = useReadiness((state) => state.linkBoard);
  /** The repo this board is on now, once the service said so. */
  const [linked, setLinked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts over
  useEffect(() => {
    setLinked(null);
    setError(null);
    setBusy(false);
  }, [check]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await linkBoard(slug, linked !== null);
      if (result.done) onOpenChange(false);
      else setLinked(result.linked);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not link the repo.",
      );
    } finally {
      setBusy(false);
    }
  }

  const from = check?.linkedTo;
  return (
    <AlertDialog
      open={check !== null}
      onOpenChange={(open) => !busy && onOpenChange(open)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {linked
              ? "Move this board off its repo?"
              : from
                ? `Move this repo here from “${from}”?`
                : "Link this repo to this board?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {linked
              ? `This board is linked to ${linked}. Linking it here takes it off that repo: agents there will no longer find this board.`
              : from
                ? `Agents in this folder will file new cards on this board. The cards already on “${from}” stay there.`
                : "Agents in this folder will file their cards on this board."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // Stays open until the service answers: a refusal is shown here.
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "Linking…" : linked ? "Move it here" : "Link here"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
