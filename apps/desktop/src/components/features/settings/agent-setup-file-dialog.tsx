import { Alert02Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { SetupDoc, SetupFile } from "#/../shared/agent-setup";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { ipcMessage } from "#/lib/ipc-error";

/**
 * One skill's `SKILL.md` or one command's file, read-only (FE-40/D4): its
 * frontmatter as written, then its body as markdown, and Reveal in Finder.
 *
 * ⚠️ Asked for by the id main handed out with the row, never by a path —
 * main finds the file again from the folder's setup as it reads now.
 */
export function AgentSetupFileDialog({
  slug,
  doc,
  onOpenChange,
}: {
  slug: string;
  /** The row to open; null keeps the dialog shut. */
  doc: SetupDoc | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<SetupFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = doc?.id ?? null;

  useEffect(() => {
    setFile(null);
    setError(null);
    const surface = window.desktop?.agentSetup;
    if (!id || !surface) return;
    let live = true;
    surface.open(slug, id).then(
      (next) => live && setFile(next),
      (failure: unknown) =>
        live && setError(ipcMessage(failure, "Could not open that file.")),
    );
    return () => {
      live = false;
    };
  }, [slug, id]);

  async function reveal() {
    if (!id) return;
    try {
      await window.desktop?.agentSetup.reveal(slug, id);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not show that file in Finder."));
    }
  }

  return (
    <Dialog open={doc !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doc?.name}</DialogTitle>
          <DialogDescription className="truncate font-mono" title={doc?.source}>
            {doc?.source}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
          {file?.truncated && (
            <Alert>
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
              <AlertDescription>
                This file is longer than one read takes; what is shown is its
                start.
              </AlertDescription>
            </Alert>
          )}
          {file?.frontmatter && (
            // Wide lines scroll inside the box; the dialog never scrolls sideways.
            <pre
              data-testid="agent-setup-frontmatter"
              className="bg-foreground/[0.04] text-muted-foreground overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre"
            >
              {file.frontmatter}
            </pre>
          )}
          {file && <MarkdownBody source={file.body} />}
          {error && (
            <p role="alert" className="text-destructive text-[13px]">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!file}
            onClick={() => void reveal()}
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              strokeWidth={1.5}
              data-icon="inline-start"
            />
            Reveal in Finder
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
