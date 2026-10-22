import { useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { useBoard } from "#/stores/board";

/**
 * Change a project's display name on the account.
 *
 * - The name only. The slug cannot move (the service refuses that field on
 *   every route), so the dialog says so rather than leave someone wondering
 *   why the mono line below the name did not follow. The folder link on this
 *   machine and the remembered selection are keyed by slug, so they survive
 *   a rename untouched.
 * - A write to the account, not this machine: every machine signed into it
 *   sees the new name, hence "on your account" rather than "here".
 * - Only reachable for a project the cloud has an id for; the caller decides.
 *   `workspace.id` is null against a service older than the field, and such
 *   a service has no rename route either.
 */
export function RenameProjectDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace & { id: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // NOTE: Seeded once, on mount. That is correct only because the caller
  // renders this dialog as `{renaming && …}`: it mounts per project and
  // unmounts on close. Keeping one mounted across rows would need the name
  // re-seeded on the way in.
  const [name, setName] = useState(workspace.name);
  const [failed, setFailed] = useState<string | null>(null);
  const busy = useBoard((state) => state.busy);
  const renameProject = useBoard((state) => state.renameProject);
  const working = busy === `rename:${workspace.id}`;

  const typed = name.trim();
  const unchanged = typed === workspace.name;

  function submit() {
    if (!typed || unchanged) return;
    setFailed(null);
    void renameProject(workspace.id, typed).then((result) => {
      // Kept on failure, as the create dialog does: the refused name is the
      // thing being edited.
      if (result.error) {
        setFailed(result.error);
        return;
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            This changes the name on your account, so every machine signed in
            sees it. The key <span className="font-mono">{workspace.slug}</span>{" "}
            stays as it is.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label={`New name for ${workspace.name}`}
            value={name}
            maxLength={200}
            disabled={working}
            autoFocus
            // The name is edited, not entered, so the cursor lands at the end
            // of what is there instead of selecting it.
            onFocus={(event) =>
              event.currentTarget.setSelectionRange(
                event.currentTarget.value.length,
                event.currentTarget.value.length,
              )
            }
            onChange={(event) => setName(event.target.value)}
          />

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
              disabled={working}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={!typed || unchanged || working}
            >
              {working ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
