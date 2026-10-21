import { GithubIcon, RecordIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RowBadge } from "#/components/shared/board/row-badge";
import { RAIL_ROW } from "#/components/shared/navigation/rail-hover";
import { Skeleton } from "#/components/ui/skeleton";
import { relativeTime } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import type { GitHubIssue, IssueLabel } from "../../../../shared/git";

export { GitHubIssuesProblemState } from "./github-issue-row.problem";

/**
 * A label's colour as CSS, or null for anything that is not six hex digits.
 *
 * ⚠️ Checked before it reaches `style`. The value is whatever the repo's
 * owner typed into GitHub, and a string that is not a colour would otherwise
 * be handed to the browser as one.
 */
function labelColor(label: IssueLabel): string | null {
  return /^[0-9a-f]{6}$/i.test(label.color) ? `#${label.color}` : null;
}

/**
 * A GitHub label, drawn as the board's tags are.
 *
 * NOTE: GitHub's colour goes on a dot, not on the chip. Filling the chip with
 * an arbitrary colour and putting the name on top would leave some labels
 * unreadable, which is why `LabelChip` does the same.
 */
function _GitHubLabel({ label }: { label: IssueLabel }) {
  const color = labelColor(label);
  return (
    <span className="bg-foreground/[0.05] text-muted-foreground inline-flex max-w-28 items-center gap-1.5 rounded px-1.5 text-[11px] leading-[15px]">
      <span
        aria-hidden="true"
        className="bg-tone-neutral size-1.5 shrink-0 rounded-full"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/**
 * One GitHub issue in the issue list, the shape and spacing of a card's row.
 *
 * ⚠️ A button, not a link. The list decides what selecting it means (the
 * route it opens), so the row cannot name a URL of its own.
 *
 * @param now When the list was read, so its ages agree with the list's.
 */
export function GitHubIssueRow({
  issue,
  now,
  selected,
  onSelect,
}: {
  issue: GitHubIssue;
  now: number;
  selected?: boolean;
  onSelect: (issue: GitHubIssue) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(issue)}
        className={cn(
          RAIL_ROW,
          "focus-visible:ring-accent-brand relative flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2",
          selected && "bg-foreground/[0.06]",
        )}
      >
        {/* NOTE: Two lines, as a card's row draws, so the list's two kinds
            of row read as one list: where it comes from, then what it is. */}
        <span className="text-muted-foreground flex w-full items-center gap-1.5 text-xs">
          <HugeiconsIcon
            icon={GithubIcon}
            className="text-foreground size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <RowBadge>
            <HugeiconsIcon
              icon={RecordIcon}
              className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Issue
          </RowBadge>
          <RowBadge>#{issue.number}</RowBadge>
          <span className="ml-auto shrink-0 pl-2 tabular-nums">
            {relativeTime(issue.updatedAt, now)}
          </span>
        </span>
        <span
          className={cn(
            "w-full truncate text-[13px]",
            selected && "font-medium",
          )}
        >
          {issue.title}
        </span>
      </button>
    </li>
  );
}

/**
 * The GitHub group's rows while the first read is in flight.
 *
 * NOTE: The rows only, no group header, sized to `GitHubIssueRow`. The list
 * draws the header itself, and it is there before the read answers.
 */
export function GitHubIssuesSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading GitHub issues"
      className="flex flex-col"
    >
      {Array.from({ length: rows }, (_, row) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder has no identity — the index is all it is.
          key={row}
          className="flex flex-col gap-1.5 px-5 py-2.5"
        >
          <div className="flex h-4 items-center gap-1.5">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="ml-auto h-2.5 w-12" />
          </div>
          <Skeleton className="h-3.5" style={{ width: `${78 - row * 10}%` }} />
        </div>
      ))}
    </div>
  );
}
