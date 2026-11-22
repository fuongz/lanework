// The "Save / Don't Save / Cancel" question for Repository › Files' unsaved
// edits, and the three ways out that ask it besides closing a tab: another
// project, another folder (`files-layout.tsx`) and the window closing.
//
// Mounted once in the app shell's route, not on the Files screen, so that a
// draft left in Files is still asked about from any other screen.
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { useFiles } from "#/stores/files";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The slug a router location is in, if it is in a project at all. */
function slugOf(location: { params: unknown }): string | undefined {
  const params = location.params as { slug?: unknown } | undefined;
  return typeof params?.slug === "string" ? params.slug : undefined;
}

/** Set once the person answered the quit question, so the close goes through. */
let leaving = false;

export function UnsavedFilesGuard() {
  const request = useFiles((state) => state.unsaved);
  const resolve = useFiles((state) => state.resolveUnsaved);
  const [saving, setSaving] = useState(false);

  // Another project: its Files store would show other buffers. The drafts
  // are kept per project anyway, but the person is asked, as an editor asks
  // before closing a workspace.
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: ({ current, next }) => {
      const files = useFiles.getState();
      const from = slugOf(current);
      const to = slugOf(next);
      if (!from || !to || from === to || files.slug !== from) return false;
      if (!Object.values(files.buffers).some((buffer) => buffer.dirty))
        return false;
      return new Promise<boolean>((done) =>
        files.confirmDiscard({
          reason: "switch",
          proceed: () => done(false),
          cancel: () => done(true),
        }),
      );
    },
  });

  // The window closing (or reloading). Electron cancels the close when
  // `beforeunload` is prevented and shows no prompt of its own, so the
  // question is this dialog; its Save or Don't Save closes the window again.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving || !useFiles.getState().hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = false;
      setTimeout(() =>
        useFiles.getState().confirmDiscard({
          reason: "quit",
          everywhere: true,
          proceed: () => {
            leaving = true;
            window.close();
          },
        }),
      );
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const paths = request?.paths ?? [];
  const elsewhere = request?.elsewhere ?? 0;
  const count = paths.length + elsewhere;
  const title =
    count === 1 && paths.length === 1
      ? `Save changes to ${basename(paths[0] ?? "")}?`
      : `Save changes to ${count} files?`;
  const description =
    request?.reason === "quit"
      ? "Your edits are lost if you close the window without saving."
      : request?.reason === "switch"
        ? "Your edits are lost if you leave without saving."
        : "Your edits are lost if you close without saving.";

  const answer = async (choice: "save" | "discard" | "cancel") => {
    setSaving(choice === "save");
    try {
      await resolve(choice);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !saving) void answer("cancel");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
            {elsewhere > 0 &&
              ` ${elsewhere === 1 ? "One file is" : `${elsewhere} files are`} open in another project or folder.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {paths.length > 1 && (
          <ul className="text-muted-foreground max-h-32 overflow-y-auto text-xs">
            {paths.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => void answer("discard")}
          >
            Don't Save
          </Button>
          <Button disabled={saving} onClick={() => void answer("save")}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
