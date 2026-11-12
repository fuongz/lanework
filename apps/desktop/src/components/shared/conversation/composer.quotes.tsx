import {
  Cancel01Icon,
  Comment01Icon,
  QuoteDownIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Quote } from "#/lib/quote";

/**
 * The quotes, as a tab on the composer's top edge (the message queue's):
 * one row each, in the order they will be sent, each with its own ×.
 */
export function QuotesTab({
  quotes,
  onRemove,
}: {
  quotes: Quote[];
  onRemove: (key: string) => void;
}) {
  if (!quotes.length) return null;
  return (
    <section
      aria-label="Quoted in the next message"
      className="bg-muted/60 border-border text-muted-foreground mx-3 flex flex-col rounded-t-lg border border-b-0 py-0.5 ps-2.5 pe-1 text-xs"
    >
      {quotes.map((quote, index) => (
        <div
          key={quote.key}
          className={
            index > 0
              ? "border-border/60 flex h-7 min-w-0 items-center gap-2 border-t"
              : "flex h-7 min-w-0 items-center gap-2"
          }
        >
          <HugeiconsIcon
            icon={quote.kind === "reply" ? Comment01Icon : QuoteDownIcon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="shrink-0">
            {quote.kind === "reply" ? "Replying to" : "About"}
          </span>
          <span
            className="text-foreground/80 min-w-0 flex-1 truncate"
            title={quote.lines.join("\n")}
          >
            {quote.lines.join(" ")}
          </span>
          <button
            type="button"
            aria-label={
              quote.kind === "reply" ? "Cancel reply" : "Remove quote"
            }
            onClick={() => onRemove(quote.key)}
            className="hover:bg-foreground/[0.06] hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        </div>
      ))}
    </section>
  );
}
