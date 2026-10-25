import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { ImagePreview } from "#/../shared/conversation";
import {
  FileOpenerContext,
  ImageViewerContext,
} from "#/components/shared/common/markdown-body";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { Skeleton } from "#/components/ui/skeleton";
import { useFiles } from "#/stores/files";

/** A file the lightbox can still show when the repository cannot. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Opens a file badge in the chat in Repository › Files, images included: a
 * kept tab, with the tree opened down to it.
 *
 * - Main finds the file (`worktree.locate`): Claude writes paths relative to
 *   the project's folder, to the repository, absolute, or as a bare name.
 * - An image chip on a tool call opens the lightbox directly on Cmd/Ctrl-click
 *   or from its context menu (`ImageViewerContext`).
 * - The lightbox stays for what the repository does not hold. An image pasted
 *   into this conversation lives outside the folder, and Files cannot open
 *   it. Anything else that cannot be found says so, in the same dialog.
 */
export function FileOpenerProvider({
  slug,
  workspace,
  conversation,
  children,
}: {
  slug: string;
  workspace: string | null;
  conversation: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const reveal = useFiles((state) => state.reveal);
  const [asked, setAsked] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [opening, setOpening] = useState(false);
  const latest = useRef(0);

  /** The lightbox, for an image only the conversation has. */
  const lightbox = useCallback(
    (path: string, mine: number) => {
      const surface = window.desktop?.conversation;
      setAsked(path);
      setPreview(null);
      if (!surface || !workspace || !IMAGE_FILE.test(path)) {
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

  const open = useCallback(
    (path: string) => {
      const mine = ++latest.current;
      const surface = window.desktop?.worktree;
      if (!surface) return lightbox(path, mine);
      void surface
        .locate(slug, path)
        .catch(() => null)
        .then((found) => {
          if (mine !== latest.current) return;
          if (!found) return lightbox(path, mine);
          reveal(slug, found);
          void navigate({ to: "/w/$slug/files", params: { slug } });
        });
    },
    [slug, reveal, navigate, lightbox],
  );

  /** Straight to the lightbox, for an image chip's Cmd/Ctrl-click or menu. */
  const view = useCallback(
    (path: string) => lightbox(path, ++latest.current),
    [lightbox],
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
  const image = asked !== null && IMAGE_FILE.test(asked);
  return (
    <FileOpenerContext.Provider value={open}>
      <ImageViewerContext.Provider value={view}>
        {children}
      </ImageViewerContext.Provider>
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
              {image ? "Image not found" : "Not found in this project’s files"}
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
    </FileOpenerContext.Provider>
  );
}
