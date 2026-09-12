import {
  Cancel01Icon,
  Folder01Icon,
  FolderAddIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { PickedFolder } from "#/../shared/workspaces";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";

/**
 * The folders a project is built from, as an editable list.
 *
 * ⚠️ ONE implementation, two dialogs: creating a project and changing an
 * existing one. They are the same list with the same rules — primary is first,
 * a folder appears once, removing the last one is allowed — and two copies
 * would be two places for those rules to drift apart.
 *
 * ⚠️ Every row is a `PickedFolder`, never a bare path, including the ones read
 * back from a workspace that already had them. Main mints the ids and resolves
 * them itself, so no screen can ask this app to read a folder nobody chose.
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

  async function add() {
    const api = window.desktop?.workspaces.folder;
    if (!api) return;
    setPicking(true);
    try {
      const picked = await api.choose();
      // Cancelling answers with nothing, which must not clear what is listed.
      if (!picked.length) return;
      onChange([
        ...folders,
        // The same folder twice is one folder, and the second row would carry
        // an id the first one already owns.
        ...picked.filter(
          (entry) => !folders.some((existing) => existing.path === entry.path),
        ),
      ]);
    } catch (cause) {
      onError?.(ipcMessage(cause, "Could not open the folder chooser."));
    } finally {
      setPicking(false);
    }
  }

  if (folders.length === 0)
    return (
      // ⚠️ A drop-target-sized button, not a link in a corner. Where a dialog's
      // second half is about folders, the way to add one is the second half.
      <button
        type="button"
        onClick={() => void add()}
        disabled={picking || disabled}
        className="border-border text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-ring/30 flex h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 disabled:opacity-50"
      >
        <HugeiconsIcon
          icon={FolderAddIcon}
          className="size-5"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* ⚠️ The label does not change while the chooser is open. The OS panel
            is modal — nobody can see this button while it is up — so a
            "Choosing…" state only ever renders to something unreadable. */}
        Add folders Lanework can read
      </button>
    );

  return (
    <ul
      aria-label="Source folders"
      className="border-border divide-border flex flex-col divide-y rounded-lg border"
    >
      {folders.map((folder, index) => (
        <li key={folder.id} className="flex h-11 items-center gap-2.5 px-2.5">
          <HugeiconsIcon
            icon={Folder01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {/* ⚠️ The name AND the path. Two checkouts of one repo have the same
              basename, and a list that cannot tell them apart is one you have
              to remove rows from to read. */}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-tight">
              {folder.name}
            </span>
            {/* ⚠️ Truncated from the LEFT. Two checkouts of one repo share
                every character of their prefix and differ at the end, so an
                ellipsis on the right hides the only part that tells them
                apart. `direction: rtl` moves the ellipsis; the `bdi` keeps the
                path itself in logical order, without which the leading slash
                is re-ordered to the far end of a short path. */}
            <span
              title={folder.path}
              dir="rtl"
              className="text-muted-foreground block truncate text-left text-[11px] leading-tight"
            >
              <bdi>{folder.path}</bdi>
            </span>
          </span>
          {/* ⚠️ Nothing is marked primary while there is only one row: a badge
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
                    // Primary IS first — the order carries the fact, so making
                    // one primary moves it where the eye already looks for it.
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

/** Said once the choice exists, and not before. */
export function PrimaryFolderHint({ folders }: { folders: PickedFolder[] }) {
  if (folders.length < 2) return null;
  return (
    <p className="text-muted-foreground text-[11px]">
      Cards and files are read from the primary folder.
    </p>
  );
}
