import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextSkeleton } from "#/components/shared/loading/skeletons";
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
 * A pull request is often many commits, and a branch built in steps reads
 * best one commit at a time. The whole pull request stays the default, since
 * a review is of the change as a whole; one commit is a lens you pick up and
 * put down.
 *
 * The commit list is read when the menu opens, never with the pull request:
 * opening one is already two round trips, and most opens never want this
 * list.
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
      : // The sha when the list has not arrived: a commit can stay selected
        // across a refresh that drops the list, and "Commit" alone would not
        // say which one.
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
            // States its own `text-xs`: it inherits no size from its row, and
            // the body size would read larger than the branch breadcrumb
            // beside it.
            className="hover:bg-foreground/[0.06] focus-visible:ring-accent-brand -mx-1.5 flex h-6 min-w-0 max-w-[22rem] items-center gap-1.5 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
          >
            {/* NOTE: Only the label may shrink. Once a commit is picked it is
                a commit subject of any length, and without `min-w-0` it
                refuses to truncate and squeezes the counts instead, which
                then wrap inside an `h-6` row. */}
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {shown.length} file{shown.length === 1 ? "" : "s"}
            </span>
            {commitDiffLoading ? (
              <TextSkeleton
                label="Reading the commit"
                className="w-12 shrink-0"
              />
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
          {/* The read hangs off the submenu's trigger, not the outer menu:
              someone switching back to the whole pull request never needs
              this list, and it would be a request per open otherwise. */}
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
