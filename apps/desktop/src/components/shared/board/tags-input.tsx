import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import { normalizeTag } from "#/../shared/workspaces";

/**
 * Tags as things, not as a sentence with commas in it.
 *
 * ⚠️ Each tag is committed the moment it is entered, and removed the moment its
 * × is clicked — one write per decision. The field this replaced held every tag
 * in one comma-separated string and saved on blur, which made "did that save?"
 * a question you could only answer by clicking somewhere else.
 *
 * ⚠️ The text is normalized HERE as well as on the board, through the same
 * mirror the main process uses. A chip that read "UI Polish" while the board
 * stored `ui-polish` would be a screen disagreeing with its own data — and the
 * disagreement would only surface on the next reload, which is the worst moment
 * to learn about it.
 *
 * ⚠️ It does NOT enforce a cap. The board applies one (3 by default) and its
 * write reports what it dropped; a limit guessed on this side would either
 * refuse a tag the board would have taken, or promise one it will not.
 */
export function TagsInput({
  tags,
  onChange,
  disabled = false,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const fieldId = useId();

  // ⚠️ Splits on commas rather than treating the text as one tag. A pasted
  // "ui, electron, cloud" is how a list actually arrives, and `normalizeTag`
  // does not strip commas — it turns spaces into hyphens, so the whole string
  // would have become the single tag `ui,-electron,-cloud`.
  const commit = (raw: string) => {
    setDraft("");
    const next = [...tags];
    for (const part of raw.split(",")) {
      const tag = normalizeTag(part);
      // A tag that normalizes to nothing ("###") and one already on the card
      // are both no-ops, and neither is worth a write the board would discard.
      if (!tag || next.includes(tag)) continue;
      next.push(tag);
    }
    if (next.length !== tags.length) onChange(next);
  };

  return (
    // ⚠️ A `label`, not a div with an onClick. Clicking anywhere in the box —
    // the padding, the gap between chips — has to put the caret in the field,
    // and a label does that natively; the same behaviour written as a click
    // handler is a static element pretending to be a control.
    //
    // ⚠️ `htmlFor` is NOT optional here, and leaving it off is a bug that
    // deletes data. A label with no `for` controls its first labelable
    // DESCENDANT — and the first one inside this box is a chip's × button, not
    // the field. So clicking the padding forwarded the click to that button and
    // silently removed the first tag, while the caret never arrived.
    <label
      htmlFor={fieldId}
      className="focus-within:ring-accent-brand flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1 py-0.5 transition-colors focus-within:ring-2 hover:bg-foreground/[0.06]"
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="bg-foreground/[0.06] flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            disabled={disabled}
            className="hover:text-foreground text-muted-foreground -mr-0.5 rounded transition-colors disabled:pointer-events-none"
            onClick={() => onChange(tags.filter((entry) => entry !== tag))}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              className="size-3"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          </button>
        </span>
      ))}
      <input
        id={fieldId}
        aria-label="Tags"
        // ⚠️ Placeholder only while the card has none. Beside three chips it
        // would be a fourth thing reading like a tag.
        placeholder={tags.length ? "" : "Add tags…"}
        value={draft}
        disabled={disabled}
        size={draft.length || 8}
        className="placeholder:text-muted-foreground min-w-16 flex-1 bg-transparent px-0.5 text-[13px] outline-none"
        onChange={(event) => {
          // A comma is how people type a list, and it ends a tag here rather
          // than becoming part of one — the board would strip it anyway.
          if (event.target.value.includes(",")) commit(event.target.value);
          else setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // ⚠️ The composer submits on Enter, and adding a tag is not
            // submitting the issue.
            event.preventDefault();
            commit(draft);
          }
          // Backspace on an empty field takes the last chip — the one gesture
          // that makes a chip list feel like text.
          if (event.key === "Backspace" && !draft && tags.length)
            onChange(tags.slice(0, -1));
          if (event.key === "Escape") setDraft("");
        }}
        // Typed but not entered still counts: leaving the field is not a way
        // people mean "discard what I just wrote".
        onBlur={() => draft && commit(draft)}
      />
    </label>
  );
}
