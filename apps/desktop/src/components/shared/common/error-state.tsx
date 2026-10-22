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
 * Strip a trailing "Try again" from a message shown above a retry button.
 *
 * Most of main's messages end by suggesting a retry: good advice in a log
 * line, a duplicate above the button. The reason is the part worth keeping;
 * the instruction is the button's job.
 */
function withoutRetryHint(message: string): string {
  return message.replace(/[\s.]*(?:Please\s+)?try again\.?\s*$/i, ".");
}

/**
 * A failure that occupies the whole pane.
 *
 * For errors that are the screen: nothing loaded, so there is nothing else to
 * look at. A failure on top of a working board stays an `Alert` banner, so it
 * does not hide the cards the user still has.
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
