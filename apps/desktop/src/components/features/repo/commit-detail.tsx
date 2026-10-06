import {
  Clock01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountOrb } from "#/components/shared/common/account-orb";
import { type LoadSides, PatchView } from "#/components/shared/diff/patch-view";
import { DiffToolbar } from "#/components/shared/repo/diff-toolbar";
import { RepoMessage } from "#/components/shared/repo/repo-empty";
import { Button } from "#/components/ui/button";
import { useWorktree } from "#/stores/worktree";
import type { CommitSummary } from "../../../../shared/worktree";

const api = () => {
  const surface = window.desktop?.worktree;
  if (!surface)
    throw new Error("This window is not connected to the desktop app.");
  return surface;
};

/** "26 Sep 2026" — a commit's day, in the reader's locale. */
function day(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function CopySha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(sha)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        strokeWidth={1.8}
        data-icon="inline-start"
        aria-hidden="true"
      />
      {copied ? "Copied" : "Commit SHA"}
    </Button>
  );
}

function CommitHeader({ commit }: { commit: CommitSummary }) {
  return (
    <header className="border-sidebar-border flex gap-3 border-b px-4 py-3">
      <AccountOrb seed={commit.authorEmail} className="size-9" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium">
              {commit.authorName}
            </span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate">{commit.authorEmail}</span>
              <time
                dateTime={commit.authoredAt}
                className="flex shrink-0 items-center gap-1"
              >
                <HugeiconsIcon
                  icon={Clock01Icon}
                  className="size-3"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {day(commit.authoredAt)}
              </time>
            </span>
          </div>
          <CopySha sha={commit.sha} />
        </div>
        <p className="text-[13px] break-words">{commit.subject}</p>
        {commit.body && (
          <p className="text-muted-foreground text-xs/relaxed break-words whitespace-pre-wrap">
            {commit.body}
          </p>
        )}
      </div>
    </header>
  );
}

/**
 * One commit: who, when, why, and what it changed (FE-22/D11).
 *
 * ⚠️ The header rides INSIDE the diff's scroller, above the first file, so a
 * long commit scrolls it away instead of pinning a block of prose over the
 * code somebody came to read.
 */
export function CommitDetail() {
  const { slug, sha } = useParams({ from: "/_app/w/$slug/history/$sha" });
  const change = useWorktree((state) => state.commit);
  const error = useWorktree((state) => state.commitError);
  const openCommit = useWorktree((state) => state.openCommit);
  const diffStyle = useWorktree((state) => state.diffStyle);

  useEffect(() => {
    void openCommit(slug, sha);
  }, [openCommit, slug, sha]);

  const counts = useMemo(
    () => new Map((change?.files ?? []).map((file) => [file.path, file])),
    [change],
  );

  /**
   * ⚠️ Both sides are read from GIT, never from disk: the file as it is now has
   * nothing to do with a commit made last week. `<sha>^` is the first parent;
   * a root commit has none, and its old side is empty.
   */
  const loadSides = useCallback<LoadSides>(
    async (oldPath, newPath) => {
      const [oldText, newText] = await Promise.all([
        api().fileText(slug, oldPath, { kind: "rev", rev: `${sha}^` }),
        api().fileText(slug, newPath, { kind: "rev", rev: sha }),
      ]);
      return { oldText: oldText ?? "", newText: newText ?? "" };
    },
    [sha, slug],
  );

  if (error && change?.commit.sha !== sha)
    return (
      <RepoMessage title="That commit could not be read" description={error} />
    );
  if (!change?.commit.sha.startsWith(sha.slice(0, 7)))
    return (
      <p className="text-muted-foreground p-4 text-xs">Reading the commit…</p>
    );

  const additions = change.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = change.files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DiffToolbar additions={additions} deletions={deletions} />
      <PatchView
        // ⚠️ Keyed by the commit: fold state belongs to one commit's files, and
        // carrying it into another's folds files that are not the same.
        key={change.commit.sha}
        patch={change.patch}
        counts={counts}
        loadSides={loadSides}
        diffStyle={diffStyle}
        focus={null}
        header={<CommitHeader commit={change.commit} />}
      />
    </div>
  );
}
