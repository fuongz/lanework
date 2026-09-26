import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { type LoadSides, PatchView } from "#/components/shared/diff/patch-view";
import { DiffToolbar } from "#/components/shared/repo/diff-toolbar";
import { RestoreDialog } from "#/components/shared/repo/restore-dialog";
import { StageBox } from "#/components/shared/repo/stage-box";
import { Button } from "#/components/ui/button";
import { useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";

const api = () => {
  const surface = window.desktop?.worktree;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/**
 * Every current change as one diff, beside the list that steers it.
 *
 * ⚠️ ALL the files, scrolled to the one clicked — not one file at a time. It is
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
  const focusFile = useWorktree((state) => state.focusFile);
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const busy = useWorktree((state) => state.busy);
  const [restoring, setRestoring] = useState<WorktreeFile[] | null>(null);

  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const current = focus ? byPath.get(focus.path) : undefined;
  const index = current ? files.indexOf(current) : -1;

  /**
   * ⚠️ The old side is HEAD's copy and the new side is the file on disk — what
   * the patch was made between. A side that does not exist (a new file's past,
   * a deleted file's present) is empty text rather than a failure, so expanding
   * around a new file's only hunk still works.
   */
  const loadSides = useCallback<LoadSides>(
    async (oldPath, newPath) => {
      const file = byPath.get(newPath);
      const [oldText, newText] = await Promise.all([
        file?.status === "untracked" || file?.status === "added"
          ? Promise.resolve("")
          : api()
              .fileText(slug, oldPath, { kind: "rev", rev: "HEAD" })
              .then((text) => text ?? ""),
        file?.status === "deleted"
          ? Promise.resolve("")
          : api()
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
  const step = (delta: number) => {
    if (!files.length) return;
    const next = files[(index + delta + files.length) % files.length];
    if (next) focusFile(next.path);
  };

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
      <DiffToolbar additions={additions} deletions={deletions}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous file"
          title="Previous file"
          disabled={files.length < 2}
          onClick={() => step(-1)}
        >
          <HugeiconsIcon
            icon={ArrowUp01Icon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next file"
          title="Next file"
          disabled={files.length < 2}
          onClick={() => step(1)}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
        {current && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void (current.staged === "full"
                ? unstage([current.path])
                : stage([current.path]))
            }
          >
            {current.staged === "full" ? "Unstage" : "Stage"}
          </Button>
        )}
      </DiffToolbar>
      {patch === null && !patchError ? (
        <p className="text-muted-foreground p-4 text-xs">Reading the diff…</p>
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
