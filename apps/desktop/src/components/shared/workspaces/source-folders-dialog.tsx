import { useEffect, useState } from "react";
import type { PickedFolder, Workspace } from "#/../shared/workspaces";
import {
  PrimaryFolderHint,
  SourceFolders,
} from "#/components/shared/common/source-folders";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { ipcMessage } from "#/lib/ipc-error";

/**
 * Change which folders on this machine a project is built from.
 *
 * - The folders only. The name is edited in `rename-project-dialog.tsx`
 *   because it is a write to the account, while these paths belong to this
 *   machine alone; two blast radii behind one "edit" button is how someone
 *   changes more than they meant to. The slug is on neither dialog: no route
 *   on the service can change one.
 * - It reads the current folders as ids rather than paths, so what is linked
 *   and what was just chosen are the same kind of thing, and the whole list
 *   goes back in one write.
 */
export function SourceFoldersDialog({
  workspace,
  open,
  onOpenChange,
  onSaved,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // NOTE: Re-read every time it opens, not once. Another window, or the
  // folder panel on the board, can have changed the link since, and editing a
  // stale list would silently put the old one back.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setFailed(null);
    void window.desktop?.workspaces.folder
      .list(workspace.slug)
      .then((current) => {
        if (!alive) return;
        setFolders(current);
        setLoading(false);
      })
      .catch((cause) => {
        if (!alive) return;
        setFailed(ipcMessage(cause, "Could not read this project's folders."));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, workspace.slug]);

  function save() {
    const api = window.desktop?.workspaces.folder;
    if (!api) return;
    setSaving(true);
    setFailed(null);
    void api
      .link(
        workspace.slug,
        folders.map((folder) => folder.id),
      )
      .then(() => {
        onSaved?.();
        onOpenChange(false);
      })
      .catch((cause) => {
        setFailed(ipcMessage(cause, "Could not save those folders."));
      })
      .finally(() => setSaving(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Source folders</DialogTitle>
          <DialogDescription>
            Where {workspace.name} lives on this machine. This list is
            remembered here only — changing it sends nothing to your account.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <ListSkeleton label="Reading the folders" rows={2} className="px-0" />
        ) : (
          // `min-w-0`: the dialog is a grid, and a grid item is content-sized
          // by default, so an unbreakable path would draw outside it.
          <div className="flex min-w-0 flex-col gap-1.5">
            <SourceFolders
              folders={folders}
              onChange={setFolders}
              onError={setFailed}
              disabled={saving}
            />
            <PrimaryFolderHint folders={folders} />
          </div>
        )}

        {failed && (
          <p role="alert" className="text-destructive text-xs">
            {failed}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            size="lg"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="lg" disabled={loading || saving} onClick={save}>
            {saving ? "Saving…" : "Save folders"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
