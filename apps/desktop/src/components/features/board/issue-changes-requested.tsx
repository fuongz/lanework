import { ViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BoardCard } from "#/../shared/projects";
import { personName } from "#/components/shared/board/people";
import { columnOf } from "#/lib/board-view";
import { relativeTime } from "#/lib/relative-time";
import { useBoard } from "#/stores/board";

/**
 * The reviewer's outstanding request for changes (BE-23), above the
 * description.
 *
 * - Nothing at all when there is none. The service answers null once the card
 *   changes lane again, so a request that was dealt with leaves on its own;
 *   the activity feed keeps it.
 * - Above the body, not in the feed: it is the first thing whoever picks the
 *   card up has to read, and three entries of history can push it out of
 *   sight.
 */
export function IssueChangesRequested({ card }: { card: BoardCard }) {
  const view = useBoard((state) => state.view);
  const request = card.changesRequested;
  if (!request) return null;
  const columns = view?.columns ?? [];
  const from = columnOf(columns, request.from)?.name ?? request.from;
  // An agent has no directory row; its slug is the honest name for it.
  const who = personName(
    view?.members ?? [],
    request.by.userId,
    request.by.agent ?? request.by.kind,
  );

  return (
    // A slim teal rule and an inline header, the way the activity feed quotes
    // a send-back reason: the same pattern, one weight, no box or tint.
    <section
      aria-label="Changes requested"
      className="border-tone-teal/60 flex flex-col gap-1 border-l-2 pl-3"
    >
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        <HugeiconsIcon
          icon={ViewIcon}
          className="text-tone-teal size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="text-foreground shrink-0 font-medium">
          Changes requested
        </span>
        {/* Who, where and when in words, never joined with a "·". */}
        <span className="truncate">
          by {who} in {from}
        </span>
        <time
          dateTime={request.at}
          title={new Date(request.at).toString()}
          className="shrink-0"
        >
          {relativeTime(request.at, Date.now())}
        </time>
      </div>
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
        {request.reason}
      </p>
    </section>
  );
}
