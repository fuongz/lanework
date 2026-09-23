import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "#/lib/utils";
import { usePulls } from "#/stores/pulls";

/**
 * An ordinary comment on a pull request.
 *
 * ⚠️ NOT the review footer, and deliberately somewhere else on the screen. A
 * review carries a verdict that can block a merge; this cannot. Putting them in
 * one control is how somebody asking a question ends up requesting changes.
 *
 * ⚠️ The box is cleared only AFTER the post succeeds. A failed send that had
 * already emptied the field is a lost paragraph, and the error message does not
 * bring it back.
 *
 * ⚠️ One bordered card rather than a textarea with a button under it: the
 * avatar and the send control sit INSIDE the field's own outline, so the whole
 * thing reads as one place to write rather than three stacked widgets.
 */
export function CommentBox({ number }: { number: number }) {
  const [body, setBody] = useState("");
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = usePulls((state) => state.commentBusy);
  const postComment = usePulls((state) => state.postComment);
  const account = usePulls((state) => state.account);
  const login = account.kind === "connected" ? account.login : null;

  const ready = body.trim() !== "" && !busy;

  const send = () => {
    if (!ready) return;
    void postComment(number, body).then((result) => {
      setError(result.error ?? null);
      if (!result.error) setBody("");
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* The outline follows focus because the real input inside it has none of
          its own — without this the card never acknowledges being typed in. */}
      <div
        className={cn(
          "border-sidebar-border rounded-xl border px-4 pt-3 pb-2.5 transition-colors",
          focused && "border-accent-brand",
        )}
      >
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            // ⌘/Ctrl+Enter sends; Enter alone does not. A comment is prose, and
            // a lone Enter is how a paragraph gets its second line.
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Leave a comment"
          rows={2}
          aria-label="Leave a comment"
          className="placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm outline-none"
        />
        <div className="flex items-center justify-between">
          {/* ⚠️ An initial, not the GitHub avatar. This window's CSP is
              `img-src 'self' data:` (see `protocol.ts`), so an
              `avatars.githubusercontent.com` URL is blocked and would draw a
              broken image — `AccountOrb` makes the same trade for the same
              reason. */}
          <span
            title={login ?? undefined}
            aria-hidden="true"
            className="bg-foreground/[0.08] flex size-7 items-center justify-center rounded-full text-[11px] font-medium uppercase"
          >
            {(login ?? "?").slice(0, 1)}
          </span>
          <button
            type="button"
            onClick={send}
            disabled={!ready}
            aria-label="Post comment"
            title="Post comment"
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              ready
                ? "bg-foreground text-background hover:opacity-90"
                : "bg-foreground/[0.12] text-background cursor-not-allowed",
            )}
          >
            <HugeiconsIcon
              icon={ArrowUp01Icon}
              className="size-4"
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {error && <p className="text-destructive text-xs/relaxed">{error}</p>}
    </div>
  );
}
