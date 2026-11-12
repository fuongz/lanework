import { useEffect, useState } from "react";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { DocumentSkeleton } from "#/components/shared/loading/skeletons";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { ScrollArea } from "#/components/ui/scroll-area";
import {
  RELEASES_URL,
  type ReleaseNotes,
  type ReleaseNotesResult,
} from "../../../../shared/updater";

/**
 * What's New (INF-11/D8): a release's notes, as GitHub holds them.
 *
 * Shown once on the first launch after an update, with the notes main has
 * already read; closing it then marks them seen. The app menu's What's New
 * opens it again, and that time it reads the notes itself.
 */
export function WhatsNewDialog() {
  const [open, setOpen] = useState(false);
  /** Null while the menu's request is being read. */
  const [result, setResult] = useState<ReleaseNotesResult | null>(null);
  /** The notes shown after an update, which closing marks seen. */
  const [afterUpdate, setAfterUpdate] = useState(false);

  useEffect(() => {
    const updater = window.desktop?.updater;
    if (!updater) return;
    let disposed = false;
    void updater
      .pendingWhatsNew()
      .then((notes: ReleaseNotes | null) => {
        if (disposed || !notes) return;
        setResult({ ok: true, notes });
        setAfterUpdate(true);
        setOpen(true);
      })
      .catch(() => {});
    const off = updater.onShowWhatsNew(() => {
      setAfterUpdate(false);
      setResult(null);
      setOpen(true);
      void updater
        .releaseNotes()
        .then((next) => {
          if (!disposed) setResult(next);
        })
        .catch(() => {
          if (!disposed)
            setResult({
              ok: false,
              reason: "unavailable",
              url: RELEASES_URL,
            });
        });
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next && afterUpdate) {
      setAfterUpdate(false);
      void window.desktop?.updater.markWhatsNewSeen().catch(() => {});
    }
  };

  const notes = result?.ok ? result.notes : null;
  const url = result ? (result.ok ? result.notes.url : result.url) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[min(36rem,calc(100vh-4rem))] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {notes ? `What's new in ${notes.title}` : "What's new in Lanework"}
          </DialogTitle>
          <DialogDescription>
            {result === null
              ? "The notes for this version, from GitHub."
              : notes
                ? afterUpdate
                  ? `Lanework was updated to ${notes.version}.`
                  : `The notes published with Lanework ${notes.version}.`
                : result.ok === false && result.reason === "dev"
                  ? "This is a development build, which has no release notes of its own."
                  : "The release notes could not be read from GitHub. Check your connection, or read them on GitHub."}
          </DialogDescription>
        </DialogHeader>
        {result === null ? (
          <DocumentSkeleton
            label="Reading the release notes"
            lines={8}
            className="p-0"
          />
        ) : notes ? (
          // The dialog has only a max-height, so a percentage height on the
          // viewport never resolves and it grows past the dialog instead of
          // scrolling. A flex column hands the viewport the area's real size.
          <ScrollArea
            className="-mx-4 flex min-h-0 flex-1 flex-col"
            viewportClassName="min-h-0 flex-1 px-4"
          >
            <MarkdownBody
              source={notes.body}
              empty="This release was published without notes."
            />
          </ScrollArea>
        ) : null}
        <DialogFooter>
          {url ? (
            <Button
              variant="outline"
              onClick={() => window.open(url, "_blank", "noopener")}
            >
              View on GitHub
            </Button>
          ) : null}
          <Button onClick={() => close(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
