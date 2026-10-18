import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { ImagePreview } from "#/../shared/conversation";
import { ImageOpenerContext } from "#/components/shared/common/markdown-body";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { Skeleton } from "#/components/ui/skeleton";

/**
 * The chat's image lightbox (FE-65): a badge naming an image — `details.png`,
 * `assets/x/still-v1.png` — opens it here, read by main from the workspace's
 * folder or the conversation's attachments. Read on click, never before.
 */
export function ImageLightboxProvider({
  workspace,
  conversation,
  children,
}: {
  workspace: string | null;
  conversation: string;
  children: ReactNode;
}) {
  const [asked, setAsked] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [opening, setOpening] = useState(false);
  const latest = useRef(0);

  const open = useCallback(
    (path: string) => {
      const surface = window.desktop?.conversation;
      const mine = ++latest.current;
      setAsked(path);
      setPreview(null);
      if (!surface || !workspace) {
        setPreview({ found: false, path });
        return;
      }
      void surface
        .image(workspace, conversation, path)
        .catch((): ImagePreview => ({ found: false, path }))
        .then((found) => {
          if (mine === latest.current) setPreview(found);
        });
    },
    [workspace, conversation],
  );

  const openInApp = () => {
    const surface = window.desktop?.conversation;
    if (!surface || !workspace || !asked || opening) return;
    setOpening(true);
    void surface
      .openImage(workspace, conversation, asked)
      .catch(() => undefined)
      .finally(() => setOpening(false));
  };

  const name = asked?.slice(asked.lastIndexOf("/") + 1) ?? "";
  return (
    <ImageOpenerContext.Provider value={workspace ? open : null}>
      {children}
      <Dialog
        open={asked !== null}
        onOpenChange={(next) => {
          if (next) return;
          latest.current++;
          setAsked(null);
          setPreview(null);
        }}
      >
        <DialogContent className="flex w-auto max-w-[min(92vw,1400px)] flex-col gap-3 p-3 sm:max-w-[min(92vw,1400px)]">
          {preview?.found ? (
            <img
              src={preview.url}
              alt={name}
              className="bg-foreground/[0.03] mx-auto block max-h-[78vh] max-w-full rounded-lg object-contain"
            />
          ) : preview ? (
            <div className="text-muted-foreground flex h-48 w-[min(92vw,28rem)] items-center justify-center rounded-lg text-[13px]">
              Image not found
            </div>
          ) : (
            <Skeleton className="h-64 w-[min(92vw,28rem)] rounded-lg" />
          )}
          <div className="flex min-w-0 items-center gap-2 pr-8">
            {asked && <FileTypeIcon path={asked} className="size-4 shrink-0" />}
            <DialogTitle
              title={preview?.path ?? asked ?? ""}
              className="min-w-0 flex-1 truncate font-mono text-xs font-normal"
            >
              {preview?.found ? preview.path : asked}
            </DialogTitle>
            {preview?.found && (
              <Button
                variant="ghost"
                size="sm"
                onClick={openInApp}
                disabled={opening}
              >
                <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} />
                Open in default app
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </ImageOpenerContext.Provider>
  );
}
