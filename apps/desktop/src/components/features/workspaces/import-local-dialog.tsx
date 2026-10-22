import type { Workspace } from "#/../shared/workspaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { useBoard } from "#/stores/board";
import { LocalFolderPanel } from "./local-folder-panel";

/**
 * Linking a folder and putting its files on the cloud board, for one project.
 *
 * It opens from Settings → Projects, not from the rail. On the rail it acted
 * on whichever project happened to be open, which made a per-project act look
 * like a global one. The projects page lists every project with the folder it
 * holds on this machine, so the door belongs next to the project it acts on.
 */
export function ImportLocalDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reload = useBoard((state) => state.reload);
  const activeSlug = useBoard((state) => state.active?.slug);
  const migrated = useBoard((state) => state.view?.migrated ?? false);
  const isOpenBoard = workspace.slug === activeSlug;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from local</DialogTitle>
          <DialogDescription>
            Where {workspace.name} lives on this machine, and how to put those
            files on its cloud board.
          </DialogDescription>
        </DialogHeader>
        <LocalFolderPanel
          workspace={workspace}
          // NOTE: Only the OPEN board's `migrated` flag says anything about
          // this project. The loaded view belongs to whatever is open, so
          // reading it for another project answers for the wrong board. The
          // panel's other signal, the folder's own `migratedAt`, covers every
          // project either way.
          boardMigrated={isOpenBoard && migrated}
          // Same reason: a reload only means something when the board behind
          // this dialog is the one that just changed owner.
          onMigrated={isOpenBoard ? () => void reload() : undefined}
        />
      </DialogContent>
    </Dialog>
  );
}
