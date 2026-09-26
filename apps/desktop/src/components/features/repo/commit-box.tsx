import {
  CloudDownloadIcon,
  GitBranchIcon,
  GitCommitIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "#/components/ui/button";
import { Kbd } from "#/components/ui/kbd";
import { Textarea } from "#/components/ui/textarea";
import { useWorktree } from "#/stores/worktree";
import type {
  BranchState,
  CommitMode,
  CommitSummary,
  WorktreeFile,
} from "../../../../shared/worktree";

/**
 * What a commit made from here would take in, and the message it would get.
 *
 * ⚠️ Staged first, tracked otherwise (FE-22/D9). With something staged the
 * button commits exactly that; with nothing staged it says "Commit Tracked" and
 * takes every change git already follows — never an untracked file, which
 * somebody has to decide to add.
 */
export function commitPlan(files: WorktreeFile[]): {
  mode: CommitMode;
  scope: WorktreeFile[];
  placeholder: string;
} {
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

export function CommitBox({
  files,
  branch,
  head,
}: {
  files: WorktreeFile[];
  branch: BranchState;
  head: CommitSummary | null;
}) {
  const message = useWorktree((state) => state.message);
  const setMessage = useWorktree((state) => state.setMessage);
  const commitChanges = useWorktree((state) => state.commitChanges);
  const fetchRemote = useWorktree((state) => state.fetchRemote);
  const busy = useWorktree((state) => state.busy);
  const actionError = useWorktree((state) => state.actionError);
  const clearActionError = useWorktree((state) => state.clearActionError);
  const { mode, scope, placeholder } = commitPlan(files);
  const canCommit = scope.length > 0 && busy === null;

  const submit = () => {
    if (canCommit) void commitChanges(mode, placeholder);
  };

  return (
    // ⚠️ `shrink-0` under a `flex-1` list: the box stays pinned to the bottom of
    // the panel while the list above it scrolls, however long it gets.
    <div className="border-sidebar-border flex shrink-0 flex-col border-t">
      <div className="flex h-9 items-center gap-2 px-3 text-xs">
        <HugeiconsIcon
          icon={GitBranchIcon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate font-medium">
          {branch.name ?? "Detached HEAD"}
        </span>
        {(branch.ahead ?? 0) > 0 && (
          <span
            className="text-muted-foreground shrink-0 tabular-nums"
            title={`${branch.ahead} commits to push`}
          >
            ↑{branch.ahead}
          </span>
        )}
        {(branch.behind ?? 0) > 0 && (
          <span
            className="text-muted-foreground shrink-0 tabular-nums"
            title={`${branch.behind} commits to pull`}
          >
            ↓{branch.behind}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy !== null}
          onClick={() => void fetchRemote()}
        >
          <HugeiconsIcon
            icon={CloudDownloadIcon}
            strokeWidth={1.8}
            data-icon="inline-start"
            aria-hidden="true"
          />
          {busy === "fetch" ? "Fetching…" : "Fetch"}
        </Button>
      </div>

      <div className="flex flex-col gap-2 px-3 pb-2">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Commit message"
          rows={4}
          className="max-h-60 min-h-20 resize-none font-mono text-xs"
        />
        {actionError && (
          <p
            role="alert"
            className="text-destructive bg-destructive/10 rounded-md px-2.5 py-1.5 text-xs/relaxed break-words whitespace-pre-wrap"
          >
            {actionError}{" "}
            <button
              type="button"
              onClick={clearActionError}
              className="underline underline-offset-2"
            >
              Dismiss
            </button>
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground min-w-0 truncate text-[11px]">
            {scope.length === 0
              ? "Nothing to commit"
              : `${scope.length} ${scope.length === 1 ? "file" : "files"} ${mode === "staged" ? "staged" : "tracked"}`}
          </span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!canCommit}
            onClick={submit}
          >
            {busy === "commit"
              ? "Committing…"
              : mode === "staged"
                ? "Commit"
                : "Commit Tracked"}
            <Kbd className="ml-1 bg-transparent text-current opacity-70">
              ⌘↩
            </Kbd>
          </Button>
        </div>
      </div>

      {head && (
        <div
          className="border-sidebar-border text-muted-foreground flex h-8 items-center gap-2 border-t px-3 text-xs"
          title={`${head.shortSha} · ${head.subject}`}
        >
          <HugeiconsIcon
            icon={GitCommitIcon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{head.subject}</span>
          <span className="ml-auto shrink-0 font-mono">{head.shortSha}</span>
        </div>
      )}
    </div>
  );
}
