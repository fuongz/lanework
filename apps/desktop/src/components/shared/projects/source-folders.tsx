import {
  Cancel01Icon,
  Folder01Icon,
  FolderAddIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type DragEvent, useState } from "react";
import type { PickedFolder } from "#/../shared/projects";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";
import { cn } from "#/lib/utils";

/**
 * The folders a project is built from, as an editable list.
 *
 * - One implementation for two dialogs, creating a project and changing one.
 *   Both follow the same rules (primary is first, a folder appears once,
 *   removing the last one is allowed), so one copy keeps them from drifting.
 * - NOTE: Every row is a {@link PickedFolder}, never a bare path, including
 *   rows read back from an existing project. Main mints the ids and resolves
 *   them itself, so no screen can ask this app to read a folder nobody chose.
 */
export function SourceFolders({
  folders,
  onChange,
  onError,
  disabled = false,
}: {
  folders: PickedFolder[];
  onChange: (next: PickedFolder[]) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);

  function merge(picked: PickedFolder[]) {
    onChange([
      ...folders,
      // The same folder twice is one folder, and the second row would carry
      // an id the first one already owns.
      ...picked.filter(
        (entry) => !folders.some((existing) => existing.path === entry.path),
      ),
    ]);
  }

  async function add() {
    const api = window.desktop?.projects.folder;
    if (!api) return;
    setPicking(true);
    try {
      const picked = await api.choose();
      // Cancelling answers with nothing, which must not clear what is listed.
      if (!picked.length) return;
      merge(picked);
    } catch (cause) {
      onError?.(ipcMessage(cause, "Could not open the folder chooser."));
    } finally {
      setPicking(false);
    }
  }

  // FE-106: folders dragged in from Finder. Only a drag that carries files
  // lights the target, so dragging text or a row across the dialog does not.
  const carriesFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");

  const dropTarget = {
    onDragOver(event: DragEvent) {
      if (disabled || !carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave(event: DragEvent) {
      // Moving onto a child fires a leave on the parent; only leaving the
      // target itself ends the highlight.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDragging(false);
    },
    async onDrop(event: DragEvent) {
      if (disabled || !carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      const api = window.desktop?.projects.folder;
      const files = Array.from(event.dataTransfer.files);
      if (!api || !files.length) return;
      try {
        const picked = await api.drop(files);
        // D2: files are skipped; a drop with no folder at all says why.
        if (!picked.length) {
          onError?.("Only folders can be added.");
          return;
        }
        merge(picked);
      } catch (cause) {
        onError?.(ipcMessage(cause, "Could not add the dropped folders."));
      }
    },
  };

  if (folders.length === 0)
    return (
      // A drop-target-sized button, not a link in a corner: where half the
      // dialog is about folders, that half is the way to add one.
      <button
        type="button"
        onClick={() => void add()}
        disabled={picking || disabled}
        {...dropTarget}
        className={cn(
          "border-border text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-ring/30 flex h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 disabled:opacity-50",
          dragging && "border-ring bg-foreground/[0.04] text-foreground",
        )}
      >
        <HugeiconsIcon
          icon={FolderAddIcon}
          className="size-5"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* The label does not change while the chooser is open: the OS panel
            is modal and covers this button, so a "Choosing…" state is never
            seen. */}
        {dragging ? "Drop to add" : "Add folders Lanework can read"}
      </button>
    );

  return (
    <ul
      aria-label="Source folders"
      {...dropTarget}
      className={cn(
        "border-border divide-border flex flex-col divide-y rounded-lg border transition-colors duration-150",
        dragging && "border-ring bg-foreground/[0.03]",
      )}
    >
      {folders.map((folder, index) => (
        <li key={folder.id} className="flex h-11 items-center gap-2.5 px-2.5">
          <HugeiconsIcon
            icon={Folder01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {/* The name and the path: two checkouts of one repo share a
              basename, and only the path tells them apart. */}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-tight">
              {folder.name}
            </span>
            {/* NOTE: Truncated from the left. Two checkouts of one repo share
                their prefix and differ at the end, so an ellipsis on the
                right hides the only part that tells them apart. `dir="rtl"`
                moves the ellipsis; the `bdi` keeps the path in logical order,
                without which the leading slash moves to the far end of a
                short path. */}
            <span
              title={folder.path}
              dir="rtl"
              className="text-muted-foreground block truncate text-left text-[11px] leading-tight"
            >
              <bdi>{folder.path}</bdi>
            </span>
          </span>
          {/* Nothing is marked primary while there is only one row: a badge
              on the only folder answers a question nobody has yet. */}
          {folders.length > 1 &&
            (index === 0 ? (
              <span className="text-muted-foreground border-border shrink-0 rounded-md border px-2 py-0.5 text-[11px]">
                Primary
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-[11px]"
                disabled={disabled}
                aria-label={`Make ${folder.name} the primary folder`}
                onClick={() =>
                  onChange([
                    // Primary is first: the order carries the fact, so making
                    // one primary moves it where the eye already looks.
                    folder,
                    ...folders.filter((entry) => entry.id !== folder.id),
                  ])
                }
              >
                Make primary
              </Button>
            ))}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            disabled={disabled}
            aria-label={`Remove ${folder.name}`}
            onClick={() =>
              onChange(folders.filter((entry) => entry.id !== folder.id))
            }
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              aria-hidden="true"
            />
          </Button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={() => void add()}
          disabled={picking || disabled}
          className="hover:bg-foreground/[0.03] focus-visible:ring-ring/30 flex h-11 w-full items-center gap-2.5 rounded-b-lg px-2.5 text-left text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={FolderAddIcon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          Add folder
        </button>
      </li>
    </ul>
  );
}

/** The note on which folder is read, shown only once there are two or more. */
export function PrimaryFolderHint({ folders }: { folders: PickedFolder[] }) {
  if (folders.length < 2) return null;
  return (
    <p className="text-muted-foreground text-[11px]">
      Cards and files are read from the primary folder.
    </p>
  );
}
