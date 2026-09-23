import {
  CheckmarkCircle02Icon,
  Comment01Icon,
  GitCommitIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { shortAge } from "#/lib/board-view";
import type { PullTimelineItem } from "../../../../shared/git";

/**
 * What happened on a pull request, oldest first.
 *
 * ⚠️ Every entry is a CARD, including the one-line ones. A timeline that boxed
 * only the entries with a body made the rest read as captions between the
 * cards rather than as events in the same list — the eye follows the outline,
 * and half the history was outside it.
 *
 * ⚠️ The SHAPE of `issue-activity.tsx`, not its code. That component speaks the
 * board's language — task cards, checklist items, lanes — and one component
 * serving two models would carry both sets of props forever.
 *
 * ⚠️ No avatars. This window's CSP is `img-src 'self' data:` (see
 * `protocol.ts`), so an `avatars.githubusercontent.com` URL would be blocked
 * and draw a broken image — which is what the reference screenshot shows
 * happening. An initial is what `AccountOrb` already does for the same reason.
 */

/** One row: a tinted glyph, a sentence, and when it happened. */
function Entry({
  icon,
  tone,
  at,
  children,
  body,
}: {
  icon: IconSvgElement;
  tone: string;
  at: string;
  children: ReactNode;
  body?: string;
}) {
  const age = shortAge(at, Date.now());
  const hasBody = body !== undefined && body.trim() !== "";
  return (
    <li className="border-sidebar-border rounded-lg border px-4 py-3">
      <div className="flex items-center gap-3">
        <HugeiconsIcon
          icon={icon}
          className={`size-4 shrink-0 ${tone}`}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 text-xs">{children}</span>
        {age && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {age}
          </span>
        )}
      </div>
      {/* ⚠️ Drawn only when there IS a body. An approval with no note is the
          commonest review there is, and an empty block under it would read as a
          comment that failed to load. */}
      {hasBody && (
        <div className="mt-2.5 pl-7 text-xs">
          {/* Elements, never HTML — see `lib/markdown`. This is text other
              people wrote, arriving in a web origin. */}
          <MarkdownBody source={body} />
        </div>
      )}
    </li>
  );
}

function Who({ login }: { login: string | null }) {
  return <span className="font-medium">{login ?? "someone"}</span>;
}

/** GitHub's review states, in words somebody reads rather than shouts. */
function verdictWords(verdict: string | null): string {
  switch ((verdict ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved these changes";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "had a review dismissed";
    default:
      return "reviewed this pull request";
  }
}

function Row({ item }: { item: PullTimelineItem }) {
  if (item.kind === "opened")
    return (
      <Entry
        icon={GitPullRequestIcon}
        tone="text-emerald-600 dark:text-emerald-400"
        at={item.at}
      >
        <Who login={item.actor} />{" "}
        <span className="text-muted-foreground">opened this pull request</span>
      </Entry>
    );

  if (item.kind === "commits")
    return (
      <Entry icon={GitCommitIcon} tone="text-muted-foreground" at={item.at}>
        <Who login={item.actor} />{" "}
        <span className="text-muted-foreground">
          pushed {item.count} commit{item.count === 1 ? "" : "s"}
        </span>
      </Entry>
    );

  if (item.kind === "review")
    return (
      <Entry
        icon={CheckmarkCircle02Icon}
        tone={
          item.verdict === "CHANGES_REQUESTED"
            ? "text-rose-600 dark:text-rose-400"
            : "text-emerald-600 dark:text-emerald-400"
        }
        at={item.at}
        body={item.body}
      >
        <Who login={item.actor} />{" "}
        <span className="text-muted-foreground">
          {verdictWords(item.verdict)}
        </span>
      </Entry>
    );

  return (
    <Entry
      icon={Comment01Icon}
      tone="text-muted-foreground"
      at={item.at}
      body={item.body}
    >
      <Who login={item.actor} />{" "}
      <span className="text-muted-foreground">commented</span>
    </Entry>
  );
}

export function PullActivityList({
  items,
  truncated,
}: {
  items: PullTimelineItem[];
  truncated: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <p className="text-muted-foreground text-xs/relaxed">
          This pull request has more history than this view loads. Open it on
          GitHub to read the rest.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
