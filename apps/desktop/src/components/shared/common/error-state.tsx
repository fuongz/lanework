import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

/**
 * Strip a trailing "Try again" from a message that is about to sit above a
 * button saying exactly that.
 *
 * ⚠️ Main writes messages for a person, and most of them end by suggesting a
 * retry — good advice in a log line, a duplicate under a retry button. The
 * REASON is the part worth keeping; the instruction is the button's job.
 */
export function withoutRetryHint(message: string): string {
  return message.replace(/[\s.]*(?:Please\s+)?try again\.?\s*$/i, ".");
}

/**
 * A failure that occupies the whole pane.
 *
 * ⚠️ For errors that ARE the screen — nothing loaded, so there is nothing else
 * to look at. A failure that lands on top of a working board stays an `Alert`
 * banner: turning that into a full-pane state would hide the very cards the
 * user still has.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  title: string;
  message?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className="bg-destructive/10 text-destructive size-10 rounded-full"
        >
          <HugeiconsIcon
            icon={AlertCircleIcon}
            className="size-5"
            strokeWidth={1.8}
          />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {message && (
          <EmptyDescription>{withoutRetryHint(message)}</EmptyDescription>
        )}
      </EmptyHeader>
      {onRetry && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
