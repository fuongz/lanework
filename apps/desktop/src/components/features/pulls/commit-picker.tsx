import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { usePulls } from "#/stores/pulls";

/**
 * Which slice of a pull request the diff is showing.
 *
 * ⚠️ It exists because a pull request is often many commits, and reviewing one
 * at a time is how anybody reads a branch that was built in steps. The whole
 * pull request stays the default — a review is of the change as a whole — and
 * one commit is a lens you pick up and put down.
 *
 * ⚠️ The commit list is read when the menu is OPENED, never with the pull
 * request. Opening a pull request is already two round trips, and most of them
 * are read without anybody wanting this list.
 */

/** `+12 −3`, in the diff's own colours, or nothing when there is nothing. */
function Counts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="shrink-0 font-mono text-xs whitespace-nowrap tabular-nums">
      {additions > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
      )}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && (
        <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>
      )}
    </span>
  );
}

export function CommitPicker({ number }: { number: number }) {
  const detail = usePulls((state) => state.detail);
  const commits = usePulls((state) => state.commits);
  const commitsLoading = usePulls((state) => state.commitsLoading);
  const commitsError = usePulls((state) => state.commitsError);
  const commit = usePulls((state) => state.commit);
  const commitDiff = usePulls((state) => state.commitDiff);
  const commitDiffLoading = usePulls((state) => state.commitDiffLoading);
  const loadCommits = usePulls((state) => state.loadCommits);
  const selectCommit = usePulls((state) => state.selectCommit);

  if (!detail) return null;

  const picked =
    commit === null
      ? null
      : (commits?.find((entry) => entry.sha === commit) ?? null);

  const label =
    commit === null
      ? "All PR changes"
      : // ⚠️ The sha when the list has not arrived. A commit can be selected
        // from a menu that is then closed and reopened after a refresh, and
        // "Commit" alone would not say which one.
        (picked?.subject ?? commit.slice(0, 7));

  const shown = commit === null ? detail.files : (commitDiff?.files ?? []);
  const additions = shown.reduce((total, file) => total + file.additions, 0);
  const deletions = shown.reduce((total, file) => total + file.deletions, 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Showing ${label}. Choose what the diff shows.`}
            // ⚠️ States its own `text-xs`. This control used to sit inside the
            // header's `text-[11px]` row and inherited the size from it; on a
            // row of its own it fell back to the body size and read larger than
            // the branch breadcrumb it shares that row with.
            className="hover:bg-foreground/[0.06] focus-visible:ring-accent-brand -mx-1.5 flex h-6 min-w-0 max-w-[22rem] items-center gap-1.5 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
          >
            {/* ⚠️ The label is the ONLY thing allowed to give way. It is a
                commit subject once a commit is picked — arbitrarily long — so
                without `min-w-0` it refuses to truncate and squeezes the counts
                instead, which then wrap inside a row that is `h-6` tall. */}
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {shown.length} file{shown.length === 1 ? "" : "s"}
            </span>
            {commitDiffLoading ? (
              <span className="shrink-0">…</span>
            ) : (
              <Counts additions={additions} deletions={deletions} />
            )}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className="size-3.5 shrink-0 opacity-70"
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onClick={() => void selectCommit(null)}>
          <HugeiconsIcon
            icon={Tick02Icon}
            className={commit === null ? "size-3.5" : "size-3.5 opacity-0"}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="flex-1">All PR changes</span>
          <Counts
            additions={detail.pull.additions}
            deletions={detail.pull.deletions}
          />
        </DropdownMenuItem>
        <DropdownMenuSub>
          {/* ⚠️ The read is hung off the submenu's own open, not the outer
              menu's: somebody switching back to the whole pull request never
              needs this list, and it is a request per open otherwise. */}
          <DropdownMenuSubTrigger
            onClick={() => {
              if (commits === null) void loadCommits(number);
            }}
            onPointerEnter={() => {
              if (commits === null) void loadCommits(number);
            }}
          >
            Commits
            {commits !== null && (
              <span className="text-muted-foreground ml-auto tabular-nums">
                {commits.length}
              </span>
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-96 overflow-y-auto">
            {commitsLoading && commits === null && (
              <DropdownMenuItem disabled>Loading commits…</DropdownMenuItem>
            )}
            {commitsError !== null && (
              <DropdownMenuItem disabled>{commitsError}</DropdownMenuItem>
            )}
            {commits?.length === 0 && (
              <DropdownMenuItem disabled>No commits.</DropdownMenuItem>
            )}
            {commits?.map((entry) => (
              <DropdownMenuItem
                key={entry.sha}
                onClick={() => void selectCommit(entry.sha)}
              >
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className={
                    commit === entry.sha ? "size-3.5" : "size-3.5 opacity-0"
                  }
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {entry.shortSha}
                </span>
                <span className="truncate">{entry.subject}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
