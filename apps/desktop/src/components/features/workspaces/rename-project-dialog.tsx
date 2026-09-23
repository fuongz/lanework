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
 * ⚠️ The NAME, and nothing else. The slug underneath it cannot move — the
 * service refuses that field on every route — so this dialog says so rather
 * than leaving somebody to wonder why the mono line below the name did not
 * follow. That is a feature: the folder link on this machine and the remembered
 * selection are both keyed by slug, and they survive a rename untouched.
 *
 * ⚠️ It is a write to the ACCOUNT, not to this machine. Every machine signed
 * into the same account sees the new name, which is why the description says
 * "on your account" rather than "here".
 *
 * ⚠️ Only reachable for a project the cloud has an id for. The caller decides
 * that — `workspace.id` is null against a service older than the field, and
 * such a service has no rename route either, so a dialog that opened anyway
 * would be a form whose submit cannot work.
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
  // ⚠️ Seeded ONCE, on mount, and that is only correct because the caller
  // renders this dialog as `{renaming && …}` — it mounts per project and
  // unmounts on close, so there is no instance left holding another row's name.
  // Keeping one mounted across rows would need the name re-seeded on the way in.
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
      // Kept on failure, exactly as the create dialog keeps it: the refused
      // name is the thing being edited.
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
            // The name is being EDITED rather than entered, so the cursor lands
            // at the end of what is already there instead of over it.
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
