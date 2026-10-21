import { CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { ImportLocalDialog } from "#/components/features/workspaces/import-local-dialog";
import {
  isMovedWorkspace,
  useSyncToCloud,
} from "#/components/shared/auth/local-mode";
import {
  SETTINGS_BUTTON,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { RenameProjectDialog } from "#/components/shared/workspaces/rename-project-dialog";
import { SourceFoldersDialog } from "#/components/shared/workspaces/source-folders-dialog";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { useBoard } from "#/stores/board";
import { isLocalWorkspace, useSession } from "#/stores/session";
import { useSettingsProject } from "#/stores/settings-project";
import { Row, SelectedProjectSection } from "./selected-project-section";

const NONE: Workspace[] = [];

/**
 * The folders linked to each project on this machine, primary first.
 *
 * ⚠️ It hands back the READ as well as the result. Editing a project's folders
 * changes nothing about the workspace list, so there would otherwise be no
 * dependency to change and the page would keep showing the old paths — and a
 * counter in the dependency array is a dependency the effect does not use.
 */
function useFolderPaths(workspaces: Workspace[]) {
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  // The slugs as one string: a new array every render must not be a reason to
  // re-read every project's folders.
  const slugs = workspaces.map((workspace) => workspace.slug).join(" ");

  const read = useCallback(async () => {
    const api = window.desktop?.workspaces.folder;
    if (!api) return;
    const entries = await Promise.all(
      slugs
        .split(" ")
        .filter(Boolean)
        .map(
          async (slug) =>
            // A folder read that fails is not worth failing the page over: the
            // row still names the project, and the folder line stays empty.
            [
              slug,
              (await api.list(slug).catch(() => [])).map(
                (folder) => folder.path,
              ),
            ] as const,
        ),
    );
    setPaths(Object.fromEntries(entries));
  }, [slugs]);

  useEffect(() => {
    void read();
  }, [read]);

  return { paths, refresh: read };
}

/**
 * Settings › Projects › General: the project picked in the sidebar's Projects
 * heading, and what this app can do to it.
 *
 * ⚠️ Create, rename and delete are all on the MACHINE surface this app holds a
 * credential for — `POST`, `PATCH` and `DELETE /v1/sync/state/workspace`. The
 * human surface (`/v1/workspaces`) is `sessionAuth` and refuses this app's
 * credential by design, so none of these three may be pointed at it.
 *
 * ⚠️ Rename moves the NAME only. No route on the service can change a slug, so
 * the key under the project's name is fixed for the life of the project —
 * which is what makes the folder link and the saved selection, both keyed by
 * slug, safe from a rename. The rename dialog says so, where the question
 * comes up (`rename-project-dialog.tsx`).
 *
 * ⚠️ Delete on this surface is not the archive the web app does. The service
 * removes the row and cascades every machine's recorded path for it, so the
 * confirmation says that rather than asking "are you sure?".
 *
 * ⚠️ No project list here any more: the picker in the sidebar chooses the
 * project, and the order lives in the project switcher (FE-32).
 */
export function WorkspacesSection() {
  const selected = useSettingsProject();
  const deleteProject = useBoard((state) => state.deleteProject);

  const [editing, setEditing] = useState<Workspace | null>(null);
  const [importing, setImporting] = useState<Workspace | null>(null);
  const [renaming, setRenaming] = useState<(Workspace & { id: string }) | null>(
    null,
  );
  // ⚠️ `id` narrowed to a string, like `renaming` above: the delete is addressed
  // by cloud id, so a project without one must not be able to reach this dialog.
  const [confirming, setConfirming] = useState<
    (Workspace & { id: string }) | null
  >(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = selected ? [selected] : NONE;
  const { paths, refresh } = useFolderPaths(shown);
  // FE-52: local mode keeps every project on this machine; signing in adds the
  // account's beside them (D6a), and a local one can then be moved (D7a).
  const signedIn = useSession(
    (state) => state.session?.principal.kind === "machine",
  );
  const { sync, syncing, error: syncError } = useSyncToCloud();
  const failure = failed ?? syncError;

  // FE-52/D7a: one click moves it to the account. Only once signed in —
  // there is no account to move it to before — and never twice.
  const canSync =
    signedIn &&
    !!selected &&
    isLocalWorkspace(selected) &&
    !isMovedWorkspace(selected);

  return (
    <>
      <SettingsPage
        title="General"
        description={
          signedIn
            ? "The project picked at the top."
            : "The project picked at the top."
        }
        sections={[
          ...(failure
            ? [
                {
                  title: "Problem",
                  hideTitle: true,
                  content: (
                    <Alert variant="destructive">
                      <AlertTitle>That did not work</AlertTitle>
                      <AlertDescription>{failure}</AlertDescription>
                    </Alert>
                  ),
                },
              ]
            : []),
          {
            title: "Project",
            hideTitle: true,
            keywords:
              "project rename folders import danger remove all issues purge delete clear reset ready readiness sync cloud",
            content: (
              <SelectedProjectSection
                // A fresh section per project, so a "Removed 12 issues" line
                // never follows the selection onto a different board.
                key={selected?.slug ?? "none"}
                workspace={selected}
                folders={selected ? (paths[selected.slug] ?? []) : []}
                onRename={setRenaming}
                onFolders={setEditing}
                onImport={setImporting}
                onDelete={setConfirming}
                onFailed={setFailed}
                extraRows={
                  canSync && selected ? (
                    <Row
                      label="Sync to cloud"
                      description="Move this project and its board to your account."
                    >
                      <Button
                        size="lg"
                        className={SETTINGS_BUTTON}
                        variant="outline"
                        aria-label={`Sync ${selected.name} to cloud`}
                        disabled={syncing !== null}
                        onClick={() => {
                          setFailed(null);
                          void sync(selected);
                        }}
                      >
                        <HugeiconsIcon
                          icon={CloudUploadIcon}
                          strokeWidth={1.8}
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {syncing === selected.id ? "Moving…" : "Sync to cloud"}
                      </Button>
                    </Row>
                  ) : null
                }
              />
            ),
          },
        ]}
      />

      {renaming && (
        <RenameProjectDialog
          workspace={renaming}
          open
          onOpenChange={(next) => !next && setRenaming(null)}
        />
      )}

      {importing && (
        <ImportLocalDialog
          workspace={importing}
          open
          onOpenChange={(next) => {
            if (next) return;
            setImporting(null);
            // The link may have been made or broken in there, and the row's
            // folder line is read separately from the workspace list.
            void refresh();
          }}
        />
      )}

      {editing && (
        <SourceFoldersDialog
          workspace={editing}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            {isLocalWorkspace(confirming) ? (
              <>
                <AlertDialogTitle>
                  Delete {confirming?.name} from this machine?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the project and its board from this machine. It
                  was never on an account, so nothing else holds a copy and it
                  cannot be undone. Files in its folder are left exactly where
                  they are.
                </AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>
                  Delete {confirming?.name} from your account?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the project and its cloud board from your
                  lanework account, along with the folder paths every machine
                  has reported for it. It cannot be undone from this app. Files
                  on this machine are left exactly where they are, and another
                  machine still syncing this project can put it back on its next
                  write.
                </AlertDialogDescription>
              </>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              // The registry button pairs `border border-transparent` with
              // `bg-clip-padding`, so the fill stops short of the edge and the
              // popup shows through as a 1px ring — the same `border-0` every
              // other destructive confirmation in this app carries.
              className="border-0"
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (!target) return;
                setFailed(null);
                void deleteProject(target.id, target.slug).then((result) => {
                  if (result.error) setFailed(result.error);
                  else void refresh();
                });
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
