import { Checkbox } from "#/components/ui/checkbox";
import { stagedTally, useWorktree } from "#/stores/worktree";
import type { WorktreeFile } from "../../../../shared/worktree";

/**
 * A checkbox standing for several files at once.
 *
 * ⚠️ Ticking a PARTIAL box stages the rest rather than unstaging what is there:
 * the half-ticked state is "some of this is going in", and the obvious next
 * step from there is all of it.
 */
export function StageBox({
  files,
  label,
}: {
  files: WorktreeFile[];
  label: string;
}) {
  const stage = useWorktree((state) => state.stage);
  const unstage = useWorktree((state) => state.unstage);
  const busy = useWorktree((state) => state.busy);
  const tally = stagedTally(files);
  return (
    <Checkbox
      aria-label={tally === "full" ? `Unstage ${label}` : `Stage ${label}`}
      checked={tally === "full"}
      indeterminate={tally === "partial"}
      disabled={busy !== null}
      onClick={(event) => event.stopPropagation()}
      onCheckedChange={() => {
        const paths = files.map((file) => file.path);
        void (tally === "full" ? unstage(paths) : stage(paths));
      }}
    />
  );
}
