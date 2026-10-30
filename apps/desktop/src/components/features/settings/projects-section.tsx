import { CloudDownloadIcon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import type { Project } from "#/../shared/projects";
import { ImportLocalDialog } from "#/components/features/projects/import-local-dialog";
import {
  isMovedProject,
  useExportToLocal,
  useSyncToCloud,
} from "#/components/shared/auth/local-mode";
import { RenameProjectDialog } from "#/components/shared/projects/rename-project-dialog";
import { SourceFoldersDialog } from "#/components/shared/projects/source-folders-dialog";
import {
  SETTINGS_BUTTON,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
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
import { isLocalProject, useSession } from "#/stores/session";
import { useSettingsProject } from "#/stores/settings-project";
import { Row, SelectedProjectSection } from "./selected-project-section";

const NONE: Project[] = [];

/**
 * The folders linked to each project on this machine, primary first.
 *
 * NOTE: It hands back the read (`refresh`) as well as the result. Editing a
 * project's folders changes nothing about the project list, so no
 * dependency would change and the page would keep the old paths. A counter in
 * the dependency array would be a dependency the effect does not use.
 */
function useFolderPaths(projects: Project[]) {
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  // The slugs as one string: a new array every render must not re-read every
  // project's folders.
  const slugs = projects.map((project) => project.slug).join(" ");

  const read = useCallback(async () => {
    const api = window.desktop?.projects.folder;
    if (!api) return;
    const entries = await Promise.all(
      slugs
        .split(" ")
        .filter(Boolean)
        .map(
          async (slug) =>
            // A failed folder read is not worth failing the page over: the row
            // still names the project, and the folder line stays empty.
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
 * NOTE: Create, rename and delete all use the machine surface this app holds
 * a credential for: `POST`, `PATCH` and `DELETE /v1/sync/state/workspace`.
 * The human surface (`/v1/workspaces`) is `sessionAuth` and refuses this
 * app's credential by design, so none of the three may be pointed at it.
 *
 * - Rename changes the name only. No route on the service can change a slug,
 *   so the folder link and the saved selection, both keyed by slug, survive
 *   a rename. The rename dialog says so (`rename-project-dialog.tsx`).
 * - Delete here is not the web app's archive. The service removes the row
 *   and every machine's recorded path for it, so the confirmation says that
 *   rather than asking "are you sure?".
 * - No project list: the sidebar's picker chooses the project, and the order
 *   lives in the project switcher.
 */
export function ProjectsSection() {
  const selected = useSettingsProject();
  const deleteProject = useBoard((state) => state.deleteProject);

  const [editing, setEditing] = useState<Project | null>(null);
  const [importing, setImporting] = useState<Project | null>(null);
  const [renaming, setRenaming] = useState<(Project & { id: string }) | null>(
    null,
  );
  // NOTE: `id` narrowed to a string, like `renaming`. The delete is addressed
  // by cloud id, so a project without one must not reach this dialog.
  const [confirming, setConfirming] = useState<
    (Project & { id: string }) | null
  >(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = selected ? [selected] : NONE;
  const { paths, refresh } = useFolderPaths(shown);
  // Local mode keeps every project on this machine. Signing in adds the
  // account's beside them (FE-52/D6a), and a local one can then be moved
  // (FE-52/D7a).
  const signedIn = useSession(
    (state) => state.session?.principal.kind === "machine",
  );
  const { sync, syncing, error: syncError } = useSyncToCloud();
  const { exportBoard, exporting, error: exportError } = useExportToLocal();
  // Keyed by the project it was about, so the line does not follow the
  // selection onto another board.
  const [exported, setExported] = useState<{
    slug: string;
    text: string;
  } | null>(null);
  const exportNote =
    exported && exported.slug === selected?.slug ? exported.text : null;
  const failure = failed ?? syncError ?? exportError;

  // One click moves it to the account. Only once signed in, since before that
  // there is no account to move it to, and never twice.
  const canSync =
    signedIn &&
    !!selected &&
    isLocalProject(selected) &&
    !isMovedProject(selected);
  // A cloud board can be copied down to this machine at any time (FE-110).
  const canExport = signedIn && !!selected?.id && !isLocalProject(selected);

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
          ...(exportNote && !failure
            ? [
                {
                  title: "Copied",
                  hideTitle: true,
                  content: (
                    <Alert>
                      <AlertTitle>Copied to this machine</AlertTitle>
                      <AlertDescription>{exportNote}</AlertDescription>
                    </Alert>
                  ),
                },
              ]
            : []),
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
                project={selected}
                folders={selected ? (paths[selected.slug] ?? []) : []}
                onRename={setRenaming}
                onFolders={setEditing}
                onImport={setImporting}
                onDelete={setConfirming}
                onFailed={setFailed}
                extraRows={
                  canExport && selected ? (
                    <Row
                      label="Export to local"
                      description="Copy this project's board to this machine. The board on your account stays as it is."
                    >
                      <Button
                        size="lg"
                        className={SETTINGS_BUTTON}
                        variant="outline"
                        aria-label={`Export ${selected.name} to local`}
                        disabled={exporting !== null}
                        onClick={() => {
                          setFailed(null);
                          setExported(null);
                          void exportBoard(selected).then((result) => {
                            if (!result) return;
                            setExported({
                              slug: selected.slug,
                              text: `${result.cards} ${result.cards === 1 ? "issue" : "issues"} copied to the local project ${result.localSlug}. Syncing it to the cloud later makes a second project there.`,
                            });
                          });
                        }}
                      >
                        <HugeiconsIcon
                          icon={CloudDownloadIcon}
                          strokeWidth={1.8}
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {exporting === selected.id
                          ? "Copying…"
                          : "Export to local"}
                      </Button>
                    </Row>
                  ) : canSync && selected ? (
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
          project={renaming}
          open
          onOpenChange={(next) => !next && setRenaming(null)}
        />
      )}

      {importing && (
        <ImportLocalDialog
          project={importing}
          open
          onOpenChange={(next) => {
            if (next) return;
            setImporting(null);
            // The link may have been made or broken in there, and the row's
            // folder line is read separately from the project list.
            void refresh();
          }}
        />
      )}

      {editing && (
        <SourceFoldersDialog
          project={editing}
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
            {isLocalProject(confirming) ? (
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
              // popup shows through as a 1px ring. Every destructive
              // confirmation in this app carries this `border-0`.
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
