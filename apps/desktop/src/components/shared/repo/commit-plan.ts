import type { CommitMode, WorktreeFile } from "../../../../shared/worktree";

/** What a commit made now would take in, and the message it would get. */
export interface CommitPlan {
  mode: CommitMode;
  scope: WorktreeFile[];
  placeholder: string;
}

/**
 * What a commit made from here would take in, and the message it would get.
 *
 * Staged first, tracked otherwise (FE-22/D9). With something staged the
 * commit takes exactly that. With nothing staged it takes every change git
 * already follows, never an untracked file, which somebody has to decide to
 * add. The Git view's commit box and the rail's Commit… dialog share it.
 */
export function commitPlan(files: WorktreeFile[]): CommitPlan {
  const staged = files.filter((file) => file.staged !== "none");
  const mode: CommitMode = staged.length ? "staged" : "tracked";
  const scope = staged.length
    ? staged
    : files.filter((file) => file.status !== "untracked");
  const placeholder =
    scope.length === 1
      ? `Update ${scope[0].path.slice(scope[0].path.lastIndexOf("/") + 1)}`
      : `Update ${scope.length} files`;
  return { mode, scope, placeholder };
}

/** "3 files staged", "1 file tracked", or "Nothing to commit". */
export function commitScopeLabel({ mode, scope }: CommitPlan): string {
  if (scope.length === 0) return "Nothing to commit";
  return `${scope.length} ${scope.length === 1 ? "file" : "files"} ${mode === "staged" ? "staged" : "tracked"}`;
}
