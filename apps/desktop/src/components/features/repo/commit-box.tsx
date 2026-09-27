import {
  ArrowDown01Icon,
  CloudDownloadIcon,
  GitBranchIcon,
  GitCommitIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
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
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Kbd } from "#/components/ui/kbd";
import { Textarea } from "#/components/ui/textarea";
import { useWorktree } from "#/stores/worktree";
import type {
  BranchState,
  CommitMode,
  CommitSummary,
  SyncAction,
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

const RUNNING: Record<SyncAction, string> = {
  fetch: "Fetching…",
  pull: "Pulling…",
  "pull-rebase": "Rebasing…",
  push: "Pushing…",
  "force-push": "Pushing…",
};

/**
 * Fetch, pull and push, as one split button.
 *
 * ⚠️ The main half is PUSH while there are local commits the upstream lacks,
 * and FETCH otherwise — the one thing worth doing next, the way a Git client's
 * toolbar reads. Everything else sits in the menu, where Force Push asks first.
 */
function SyncButton({
  branch,
  remotes,
}: {
  branch: BranchState;
  remotes: string[];
}) {
  const sync = useWorktree((state) => state.sync);
  const busy = useWorktree((state) => state.busy);
  const [confirmForce, setConfirmForce] = useState(false);
  const ahead = branch.ahead ?? 0;
  const primary: SyncAction = ahead > 0 ? "push" : "fetch";
  const running =
    busy !== null && busy in RUNNING ? (busy as SyncAction) : null;
  const noRemote = remotes.length === 0;
  const disabled = busy !== null || noRemote;
  // No upstream means nothing to pull from; a push then publishes the branch.
  const canPull = branch.ahead !== null;
  const canPush = branch.name !== null;

  return (
    <div
      className="ml-auto flex shrink-0 items-center"
      title={noRemote ? "This repository has no remote." : undefined}
    >
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none"
        disabled={disabled}
        onClick={() => void sync(primary)}
      >
        {running ? (
          RUNNING[running]
        ) : primary === "push" ? (
          <>
            <span className="tabular-nums">↑{ahead}</span>
            Push
          </>
        ) : (
          <>
            <HugeiconsIcon
              icon={CloudDownloadIcon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            Fetch
          </>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button
              variant="outline"
              size="icon-sm"
              // Overlap the shared edge so the two halves draw one border.
              className="-ml-px rounded-l-none"
              aria-label="More sync actions"
            />
          }
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => void sync("fetch")}>
            Fetch
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Fetch From</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote}
                  onClick={() => void sync("fetch", remote)}
                >
                  {remote}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={!canPull}
            onClick={() => void sync("pull")}
          >
            Pull
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canPull}
            onClick={() => void sync("pull-rebase")}
          >
            Pull (Rebase)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!canPush}
            onClick={() => void sync("push")}
          >
            Push
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!canPush}>
              Push To
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote}
                  onClick={() => void sync("push", remote)}
                >
                  {remote}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            variant="destructive"
            disabled={!canPull}
            onClick={() => setConfirmForce(true)}
          >
            Force Push
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmForce} onOpenChange={setConfirmForce}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force push {branch.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the branch on the remote with your local one.
              Commits on the remote that are not in your branch are removed. The
              push is refused if the remote changed since your last fetch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="border-0"
              onClick={() => {
                setConfirmForce(false);
                void sync("force-push");
              }}
            >
              Force Push
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CommitBox({
  files,
  branch,
  head,
  remotes,
}: {
  files: WorktreeFile[];
  branch: BranchState;
  head: CommitSummary | null;
  remotes: string[];
}) {
  const message = useWorktree((state) => state.message);
  const setMessage = useWorktree((state) => state.setMessage);
  const commitChanges = useWorktree((state) => state.commitChanges);
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
        {(branch.behind ?? 0) > 0 && (
          <span
            className="text-muted-foreground shrink-0 tabular-nums"
            title={`${branch.behind} commits to pull`}
          >
            ↓{branch.behind}
          </span>
        )}
        <SyncButton branch={branch} remotes={remotes} />
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
