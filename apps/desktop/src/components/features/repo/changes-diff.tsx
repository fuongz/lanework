import { Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { type LoadSides, PatchView } from "#/components/shared/diff/patch-view";
import { DocumentSkeleton } from "#/components/shared/loading/skeletons";
import { RestoreDialog } from "#/components/shared/repo/restore-dialog";
import { StageBox } from "#/components/shared/repo/stage-box";
import { Button } from "#/components/ui/button";
import { desktopSurface } from "#/server/desktop";
import { useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";

/**
 * Every current change as one diff, beside the list that steers it.
 *
 * All the files, scrolled to the one clicked, not one file at a time. It is
 * the pull request's model (the list is a table of contents for a single
 * scroll), and it means ↑/↓ and a scroll wheel reach the same places.
 */
export function ChangesDiff({
  slug,
  files,
}: {
  slug: string;
  files: WorktreeFile[];
}) {
  const patch = useWorktree((state) => state.patch);
  const patchError = useWorktree((state) => state.patchError);
  const diffStyle = useWorktree((state) => state.diffStyle);
  const focus = useWorktree((state) => state.focus);
  const [restoring, setRestoring] = useState<WorktreeFile[] | null>(null);

  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );

  /**
   * Reads both sides of a file for expanding around a hunk.
   *
   * The old side is HEAD's copy and the new side is the file on disk: what
   * the patch was made between. A side that does not exist (a new file's
   * past, a deleted file's present) is empty text rather than a failure, so
   * expanding around a new file's only hunk still works.
   */
  const loadSides = useCallback<LoadSides>(
    async (oldPath, newPath) => {
      const file = byPath.get(newPath);
      const [oldText, newText] = await Promise.all([
        file?.status === "untracked" || file?.status === "added"
          ? Promise.resolve("")
          : desktopSurface("worktree")
              .fileText(slug, oldPath, { kind: "rev", rev: "HEAD" })
              .then((text) => text ?? ""),
        file?.status === "deleted"
          ? Promise.resolve("")
          : desktopSurface("worktree")
              .fileText(slug, newPath, { kind: "worktree" })
              .then((text) => text ?? ""),
      ]);
      return { oldText, newText };
    },
    [byPath, slug],
  );

  const fileLeading = useCallback(
    (path: string) => {
      const file = byPath.get(path);
      return file ? <StageBox files={[file]} label={path} /> : null;
    },
    [byPath],
  );

  const fileActions = useCallback(
    (path: string) => {
      const file = byPath.get(path);
      if (!file) return null;
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRestoring([file])}
          aria-label={`Discard changes to ${path}`}
        >
          <HugeiconsIcon
            icon={Undo02Icon}
            strokeWidth={1.8}
            data-icon="inline-start"
            aria-hidden="true"
          />
          Restore
        </Button>
      );
    },
    [byPath],
  );

  const counts = byPath;

  const notes =
    patchError || (patch?.skipped ?? 0) > 0 ? (
      <div className="p-4 pb-2">
        <p className="text-muted-foreground bg-foreground/[0.04] rounded-md px-3 py-2 text-xs/relaxed">
          {patchError ??
            `${patch?.skipped} more untracked files are listed but not shown here.`}
        </p>
      </div>
    ) : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {patch === null && !patchError ? (
        <DocumentSkeleton label="Reading the diff" code />
      ) : (
        <PatchView
          patch={patch?.patch ?? ""}
          counts={counts}
          loadSides={loadSides}
          diffStyle={diffStyle}
          focus={focus}
          header={notes}
          fileLeading={fileLeading}
          fileActions={fileActions}
        />
      )}
      <RestoreDialog files={restoring} onClose={() => setRestoring(null)} />
    </div>
  );
}
