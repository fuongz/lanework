import { useState } from "react";
import { ComposerCard } from "#/components/shared/common/composer-card";
import { usePulls } from "#/stores/pulls";

/**
 * An ordinary comment on a pull request.
 *
 * - Not the review footer, and placed apart from it. A review carries a
 *   verdict that can block a merge; this cannot. One control for both is how
 *   someone asking a question ends up requesting changes.
 * - NOTE: The box is cleared only after the post succeeds. A failed send that
 *   had already emptied the field loses the paragraph.
 * - The frame (outline, initial, send button) is {@link ComposerCard}, shared
 *   with an issue's Activity so both comment boxes are one shape.
 */
export function CommentBox({ number }: { number: number }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = usePulls((state) => state.commentBusy);
  const postComment = usePulls((state) => state.postComment);
  const account = usePulls((state) => state.account);
  const login = account.kind === "ok" ? account.login : null;

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
      <ComposerCard
        initial={login}
        who={login}
        ready={ready}
        sending={busy}
        onSend={send}
      >
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
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
      </ComposerCard>
      {error && <p className="text-destructive text-xs/relaxed">{error}</p>}
    </div>
  );
}
