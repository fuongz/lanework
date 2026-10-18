import { useState } from "react";
import type { PromptLine } from "#/components/shared/conversation/turn-view";
import { cn } from "#/lib/utils";

/** Fewer prompts than this and there is nothing to find: no rail (D5). */
export const TOC_MIN = 3;
/** One tick's slot, px — its hit area; the rail shrinks them to fit. */
const TICK = 12;

/**
 * The conversation's table of contents (D5): one short tick per prompt on
 * the right edge, the one in view brighter and longer. Hovering a tick shows
 * the prompt and the first line of its answer; a click scrolls to it.
 */
export function TocRail({
  entries,
  current,
  onJump,
}: {
  entries: PromptLine[];
  current: string | null;
  onJump: (id: string) => void;
}) {
  const [hover, setHover] = useState<{ index: number; top: number } | null>(
    null,
  );
  if (entries.length < TOC_MIN) return null;
  const shown = hover ? entries[hover.index] : undefined;
  return (
    <nav
      aria-label="Prompts in this conversation"
      onPointerLeave={() => setHover(null)}
      className="absolute top-1/2 right-2 z-10 flex w-7 -translate-y-1/2 flex-col"
      style={{ height: `min(${entries.length * TICK}px, 70%)` }}
    >
      {entries.map((entry, index) => {
        const active = entry.id === current;
        return (
          <button
            key={entry.id}
            type="button"
            aria-label={entry.prompt}
            aria-current={active ? "location" : undefined}
            onClick={() => onJump(entry.id)}
            onPointerEnter={(event) =>
              setHover({
                index,
                top:
                  event.currentTarget.offsetTop +
                  event.currentTarget.offsetHeight / 2,
              })
            }
            onFocus={(event) =>
              setHover({
                index,
                top:
                  event.currentTarget.offsetTop +
                  event.currentTarget.offsetHeight / 2,
              })
            }
            onBlur={() => setHover(null)}
            className="group/tick flex min-h-0 flex-1 items-center justify-end outline-none"
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-[1.5px] rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none",
                active
                  ? "bg-foreground w-[18px]"
                  : "bg-foreground/25 group-hover/tick:bg-foreground/60 group-focus-visible/tick:bg-foreground/60 w-3",
              )}
            />
          </button>
        );
      })}
      {shown && hover && (
        // Glass, as the composer's menus: the chat blurred under it.
        <div
          role="tooltip"
          className="text-popover-foreground ring-foreground/12 dark:ring-foreground/15 bg-popover/40 dark:bg-muted/45 pointer-events-none absolute right-9 flex w-80 -translate-y-1/2 flex-col gap-1.5 rounded-2xl px-4 py-3.5 text-[13px] shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45),inset_0_1px_0_0_rgb(255_255_255/0.06)] ring-1 before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-3xl before:backdrop-saturate-[1.8]"
          style={{ top: hover.top }}
        >
          <p className="truncate text-[14px] font-medium">{shown.prompt}</p>
          {shown.reply && (
            <p className="text-muted-foreground line-clamp-2 leading-relaxed">
              {shown.reply}
            </p>
          )}
          {shown.more && (
            <p className="text-muted-foreground/80 border-foreground/15 mt-0.5 line-clamp-2 border-l-2 ps-3 leading-relaxed">
              {shown.more}
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
