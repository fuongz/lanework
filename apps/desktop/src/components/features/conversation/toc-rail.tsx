import { useState } from "react";
import { cn } from "#/lib/utils";

/** Fewer prompts than this and there is nothing to find: no rail (D5). */
export const TOC_MIN = 3;
/** One tick's slot, px — its hit area; the rail shrinks them to fit. */
const TICK = 9;

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
  entries: { id: string; prompt: string; reply: string }[];
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
      className="absolute top-1/2 right-1.5 z-10 flex w-6 -translate-y-1/2 flex-col"
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
                "h-px rounded-full transition-[width,background-color] duration-150",
                active
                  ? "bg-foreground w-4"
                  : "bg-foreground/25 group-hover/tick:bg-foreground/60 group-focus-visible/tick:bg-foreground/60 w-2.5",
              )}
            />
          </button>
        );
      })}
      {shown && hover && (
        <div
          role="tooltip"
          className="bg-popover text-popover-foreground ring-foreground/10 pointer-events-none absolute right-8 w-72 -translate-y-1/2 rounded-xl px-3.5 py-3 text-[13px] shadow-lg ring-1"
          style={{ top: hover.top }}
        >
          <p className="truncate">
            {/* "remove title:", as the reference reads — but a prompt that
                  already ends in punctuation keeps its own. */}
            {/[.?!:…]$/.test(shown.prompt) ? shown.prompt : `${shown.prompt}:`}
          </p>
          {shown.reply && (
            <p className="text-muted-foreground mt-1 line-clamp-2">
              {shown.reply}
            </p>
          )}
        </div>
      )}
    </nav>
  );
}
