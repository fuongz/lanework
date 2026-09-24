import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/**
 * The card a comment is written in: the field, the writer's initial and a
 * round send button, all inside one outline.
 *
 * ⚠️ One shape for every comment box in the app — the pull request's Summary
 * and an issue's Activity both use it. They drifted apart once (a bare editor
 * with a grey "Comment" button under it on issues), and two ways to write a
 * reply on neighbouring screens read as two different features.
 *
 * ⚠️ The field is a CHILD, not a prop. An issue writes markdown in CodeMirror
 * and a pull request writes into a plain textarea; the card only owns the
 * frame around them, never how text is entered.
 *
 * ⚠️ An initial, not an avatar image. This window's CSP is `img-src 'self'
 * data:` (see `protocol.ts`), so a remote avatar URL would draw a broken image
 * — `AccountOrb` makes the same trade for the same reason.
 */
export function ComposerCard({
  children,
  initial,
  who,
  ready,
  sending = false,
  onSend,
}: {
  children: ReactNode;
  /** Whose reply this is — its first letter is drawn; null draws "?". */
  initial: string | null;
  /** A tooltip for the initial, e.g. the login it came from. */
  who?: string | null;
  /** True when there is something to send and nothing in the way. */
  ready: boolean;
  sending?: boolean;
  onSend: () => void;
}) {
  return (
    // The outline follows focus because the field inside has none of its own —
    // without this the card never acknowledges being typed in.
    <div className="border-sidebar-border focus-within:border-accent-brand rounded-xl border px-4 pt-3 pb-2.5 transition-colors">
      {children}
      <div className="flex items-center justify-between">
        <span
          title={who ?? undefined}
          aria-hidden="true"
          className="bg-foreground/[0.08] flex size-7 items-center justify-center rounded-full text-[11px] font-medium uppercase"
        >
          {(initial ?? "?").slice(0, 1)}
        </span>
        <button
          type="button"
          onClick={onSend}
          disabled={!ready}
          aria-label="Post comment"
          title={sending ? "Posting…" : "Post comment"}
          className={cn(
            "flex size-8 items-center justify-center rounded-full transition-colors",
            ready
              ? "bg-foreground text-background hover:opacity-90"
              : "bg-foreground/[0.12] text-background cursor-not-allowed",
          )}
        >
          <HugeiconsIcon
            icon={ArrowUp01Icon}
            className={cn("size-4", sending && "animate-pulse")}
            strokeWidth={2.2}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}
