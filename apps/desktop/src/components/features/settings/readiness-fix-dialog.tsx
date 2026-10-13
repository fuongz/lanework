import { useEffect, useState } from "react";
import type { ReadinessFix, ReadinessPreview } from "#/../shared/readiness";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import { useReadiness } from "#/stores/readiness";

type Line = { kind: "same" | "add" | "remove"; text: string };

/** Lines kept above and below a change, like a patch. */
const CONTEXT = 3;

/**
 * `before` → `after` as lines.
 *
 * ⚠️ Prefix and suffix, not a real diff: every fix appends a block or adds
 * one key, so the change is always one contiguous run, and that is all this
 * has to draw.
 */
function lineDiff(before: string | null, after: string): Line[] {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return [
    ...a
      .slice(Math.max(0, head - CONTEXT), head)
      .map((text) => ({ kind: "same" as const, text })),
    ...a
      .slice(head, a.length - tail)
      .map((text) => ({ kind: "remove" as const, text })),
    ...b
      .slice(head, b.length - tail)
      .map((text) => ({ kind: "add" as const, text })),
    ...b
      .slice(b.length - tail, b.length - tail + CONTEXT)
      .map((text) => ({ kind: "same" as const, text })),
  ];
}

const SIGN = { same: " ", add: "+", remove: "-" } as const;

/**
 * What a readiness fix would write, shown before it is written (FE-30/D5).
 *
 * ⚠️ Nothing is written until Apply, and Apply sends the file as this dialog
 * showed it: if it changed in between, main refuses and says so.
 */
export function ReadinessFixDialog({
  slug,
  fix,
  onOpenChange,
}: {
  slug: string;
  /** The fix to preview; null keeps the dialog shut. */
  fix: ReadinessFix | null;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useReadiness((state) => state.preview);
  const apply = useReadiness((state) => state.apply);
  const [shown, setShown] = useState<ReadinessPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setShown(null);
    setError(null);
    if (!fix) return;
    let live = true;
    preview(slug, fix).then(
      (next) => live && setShown(next),
      (failure: unknown) =>
        live &&
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not preview that.",
        ),
    );
    return () => {
      live = false;
    };
  }, [fix, preview, slug]);

  async function confirm() {
    if (!shown) return;
    setBusy(true);
    setError(null);
    try {
      await apply(slug, shown.fix, shown.before);
      onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Could not apply that.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={fix !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {shown
              ? shown.before === null
                ? `Create ${shown.file}`
                : `Update ${shown.file}`
              : "Preview the change"}
          </DialogTitle>
          <DialogDescription>
            Written to this project's folder and not committed. Review it in
            your git client like any other change.
          </DialogDescription>
        </DialogHeader>
        {shown && (
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded-md py-2 font-mono text-xs leading-relaxed">
            {lineDiff(shown.before, shown.after).map((line, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a static render of lines
                key={index}
                className={cn(
                  "px-3 whitespace-pre-wrap",
                  line.kind === "add" && "bg-tone-emerald/15",
                  line.kind === "remove" && "bg-destructive/10",
                  line.kind === "same" && "text-muted-foreground",
                )}
              >
                <span aria-hidden="true" className="mr-2 select-none">
                  {SIGN[line.kind]}
                </span>
                {line.text || " "}
              </div>
            ))}
          </pre>
        )}
        {error && (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!shown || busy} onClick={() => void confirm()}>
            {busy ? "Applying…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
