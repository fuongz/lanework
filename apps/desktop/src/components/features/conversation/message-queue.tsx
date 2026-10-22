import {
  Delete02Icon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { QueuedMessage } from "#/../shared/conversation";

/**
 * The messages the engine holds back, drawn on top of the composer.
 *
 * They could not go into the running turn yet. Each one can be taken back to
 * the composer to edit (✏️, or ↑ there for the last) or dropped. A queue that
 * Stop paused waits for Resume.
 */
export function MessageQueue({
  queue,
  paused,
  onEdit,
  onRemove,
  onResume,
  onClear,
}: {
  queue: QueuedMessage[];
  paused: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onResume: () => void;
  onClear: () => void;
}) {
  if (queue.length === 0) return null;
  const failed = queue.some((message) => message.error);
  return (
    <section
      aria-label="Queued messages"
      className="bg-muted/60 border-border text-muted-foreground mx-3 rounded-t-lg border border-b-0 px-2.5 py-1 text-xs"
    >
      <div className="flex h-6 items-center gap-2">
        {paused && (
          <HugeiconsIcon
            icon={PauseIcon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {paused
            ? failed
              ? "A message could not be sent"
              : "Queue paused because you stopped"
            : `${queue.length} queued`}
        </span>
        {paused && (
          <button
            type="button"
            onClick={onResume}
            className="hover:bg-foreground/[0.06] hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors"
          >
            <HugeiconsIcon
              icon={PlayIcon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            {failed ? "Retry" : "Resume"}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="hover:text-foreground shrink-0 underline underline-offset-2 transition-colors"
        >
          Clear
        </button>
      </div>
      <ul>
        {queue.map((message) => {
          const label =
            message.text.trim() ||
            `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
          return (
            <li
              key={message.id}
              className="border-border/60 flex min-h-7 items-center gap-1 border-t"
            >
              <div className="min-w-0 flex-1 py-1">
                <p className="text-foreground/80 truncate" title={label}>
                  {label}
                  {message.text.trim() && message.attachments.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {message.attachments.length} attached
                    </span>
                  )}
                </p>
                {message.error && (
                  <p role="alert" className="text-destructive truncate">
                    {message.error}
                  </p>
                )}
              </div>
              <button
                type="button"
                title="Edit queued message"
                aria-label="Edit queued message"
                onClick={() => onEdit(message.id)}
                className="hover:bg-foreground/[0.06] hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors"
              >
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                title="Remove queued message"
                aria-label="Remove queued message"
                onClick={() => onRemove(message.id)}
                className="hover:bg-foreground/[0.06] hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors"
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  className="size-3.5"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
