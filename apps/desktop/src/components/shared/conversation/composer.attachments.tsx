import { Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { FileTypeIcon } from "#/components/shared/diff/diff-icons";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import type { PendingAttachment } from "#/stores/conversation-sends";

/**
 * The remove button on an attachment's top-right corner: a small round ×
 * that shows while the attachment is hovered or holds the focus.
 */
function RemoveCorner({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      onClick={onRemove}
      className="bg-background text-muted-foreground hover:text-foreground ring-border absolute -top-1.5 -right-1.5 z-10 grid size-5 place-items-center rounded-full opacity-0 shadow-sm ring-1 transition-opacity duration-150 group-focus-within/attachment:opacity-100 group-hover/attachment:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
    >
      <HugeiconsIcon icon={Cancel01Icon} className="size-3" strokeWidth={2.2} />
    </button>
  );
}

/**
 * One attachment above the prompt.
 *
 * - An image with a preview: a square thumbnail; a click opens it large.
 * - Anything else (or an image restored without its bytes): a chip with its
 *   type's icon and its name.
 *
 * Either way the × sits on the top-right corner and shows on hover.
 */
export function AttachmentTile({
  file,
  preview,
  onRemove,
}: {
  file: PendingAttachment;
  /** An object or data URL of the image, when there is one. */
  preview: string | undefined;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (file.image && preview)
    return (
      <span className="group/attachment relative flex">
        <button
          type="button"
          aria-label={`Preview ${file.name}`}
          title={file.name}
          onClick={() => setOpen(true)}
          className="ring-border focus-visible:ring-ring/40 size-14 overflow-hidden rounded-xl ring-1 outline-none focus-visible:ring-2"
        >
          <img
            src={preview}
            alt=""
            draggable={false}
            className="size-full object-cover"
          />
        </button>
        <RemoveCorner name={file.name} onRemove={onRemove} />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-auto max-w-[min(90vw,1100px)] gap-2 p-2 sm:max-w-[min(90vw,1100px)]">
            <DialogTitle className="sr-only">{file.name}</DialogTitle>
            <img
              src={preview}
              alt={file.name}
              className="max-h-[80vh] max-w-full rounded-lg object-contain"
            />
          </DialogContent>
        </Dialog>
      </span>
    );
  return (
    <span className="group/attachment bg-foreground/[0.06] text-foreground relative flex h-7 max-w-60 items-center gap-1.5 rounded-lg px-2.5 text-xs">
      {file.folder ? (
        <HugeiconsIcon
          icon={Folder01Icon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <FileTypeIcon path={file.name} className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{file.name}</span>
      <RemoveCorner name={file.name} onRemove={onRemove} />
    </span>
  );
}
