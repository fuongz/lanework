import { Add01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { ImportLocalDialog } from "#/components/features/workspaces/import-local-dialog";
import { RenameProjectDialog } from "#/components/features/workspaces/rename-project-dialog";
import { SourceFoldersDialog } from "#/components/features/workspaces/source-folders-dialog";
import { CreateProjectDialog } from "#/components/shared/common/create-project-dialog";
import {
  SettingsCard,
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
 * Every project on the account, and the three things this app can do to one.
 *
 * ⚠️ Create, rename and delete are all on the MACHINE surface this app holds a
 * credential for — `POST`, `PATCH` and `DELETE /v1/sync/state/workspace`. The
 * human surface (`/v1/workspaces`) is `sessionAuth` and refuses this app's
 * credential by design, so none of these three may be pointed at it.
 *
 * ⚠️ Rename moves the NAME only. No route on the service can change a slug, so
 * the mono line under each name is fixed for the life of the project — which is
 * what makes the folder link and the saved selection, both keyed by slug, safe
 * from a rename. The page states that rather than leaving it to be discovered.
 *
 * ⚠️ Delete on this surface is not the archive the web app does. The service
 * removes the row and cascades every machine's recorded path for it, so the
 * confirmation says that rather than asking "are you sure?".
 */
export function WorkspacesSection() {
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const ready = useBoard((state) => state.ready);
  const busy = useBoard((state) => state.busy);
  const hydrate = useBoard((state) => state.hydrate);
  const deleteProject = useBoard((state) => state.deleteProject);

  const [creating, setCreating] = useState(false);
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
  const { paths, refresh } = useFolderPaths(workspaces);

  // Settings can be opened straight from a cold start, with nothing loaded.
  useEffect(() => {
    if (!ready) void hydrate();
  }, [ready, hydrate]);

  return (
    <>
      <SettingsPage
        title="Projects"
        description="Every project on your lanework account, and where each one lives on this machine."
        sections={[
          {
            title: "On this account",
            keywords:
              "workspace workspaces project projects create delete remove folder folders add new",
            content: (
              <div className="flex flex-col gap-3">
                {failed && (
                  <Alert variant="destructive">
                    <AlertTitle>That did not work</AlertTitle>
                    <AlertDescription>{failed}</AlertDescription>
                  </Alert>
                )}

                <SettingsCard>
                  {!ready ? (
                    <p className="text-muted-foreground px-4 py-3.5 text-sm">
                      Reading your projects…
                    </p>
                  ) : workspaces.length === 0 ? (
                    <p className="text-muted-foreground px-4 py-3.5 text-sm">
                      No projects on this account yet.
                    </p>
                  ) : (
                    workspaces.map((workspace) => {
                      const linked = paths[workspace.slug] ?? [];
                      return (
                        <div
                          key={workspace.slug}
                          className="flex items-center justify-between gap-6 px-4 py-3.5"
                        >
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate text-sm font-medium">
                              {workspace.name}
                              {workspace.slug === active?.slug && (
                                <span className="text-muted-foreground ml-2 text-xs font-normal">
                                  open
                                </span>
                              )}
                            </span>
                            {/* ⚠️ The slug is shown because it is what the
                                folder link is keyed by and what a URL names —
                                not decoration. It no longer deletes anything:
                                that moved to the cloud id, which is not a key a
                                person should have to read. */}
                            <span className="text-muted-foreground truncate font-mono text-xs">
                              {workspace.slug}
                            </span>
                            <span
                              className="text-muted-foreground truncate text-[13px] leading-relaxed"
                              title={linked.join(" · ")}
                            >
                              {linked.length === 0
                                ? "No folder on this machine"
                                : linked.length === 1
                                  ? linked[0]
                                  : `${linked[0]} + ${linked.length - 1} more`}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              aria-label={`Rename ${workspace.name}`}
                              // ⚠️ Disabled with a REASON, not hidden. A project
                              // with no cloud id is a service older than that
                              // field — the same state that stops its board from
                              // opening — and a button that quietly vanished
                              // would leave nothing to explain why.
                              disabled={
                                !workspace.id ||
                                busy === `rename:${workspace.id}`
                              }
                              title={
                                workspace.id
                                  ? undefined
                                  : "This project has no cloud id yet, so it cannot be renamed from here."
                              }
                              onClick={() =>
                                workspace.id &&
                                setRenaming({ ...workspace, id: workspace.id })
                              }
                            >
                              {busy === `rename:${workspace.id}`
                                ? "Saving…"
                                : "Rename"}
                            </Button>
                            <Button
                              variant="outline"
                              aria-label={`Source folders for ${workspace.name}`}
                              onClick={() => setEditing(workspace)}
                            >
                              <HugeiconsIcon
                                icon={Folder01Icon}
                                strokeWidth={1.5}
                                data-icon="inline-start"
                              />
                              Folders
                            </Button>
                            {/* ⚠️ NOT disabled without a cloud id, unlike
                                Rename and Delete. Those two cannot act at all;
                                this panel still reads the folder and says what
                                is in it — which is the one place that answers
                                "where did my cards go?" when the service is too
                                old to address a board. The panel itself withdraws
                                the send, and says why. */}
                            <Button
                              variant="ghost"
                              aria-label={`Import from local into ${workspace.name}`}
                              onClick={() => setImporting(workspace)}
                            >
                              Import from local
                            </Button>
                            <Button
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              aria-label={`Delete ${workspace.name}`}
                              // ⚠️ Disabled with a REASON, like Rename. The
                              // machine surface deletes by cloud id and refuses
                              // a slug, so a project from a service older than
                              // that field cannot be deleted here — and a button
                              // that silently did nothing is the exact failure
                              // the service moved keyspace to stop.
                              disabled={
                                !workspace.id ||
                                busy === `delete:${workspace.slug}`
                              }
                              title={
                                workspace.id
                                  ? undefined
                                  : "This project has no cloud id yet, so it cannot be deleted from here."
                              }
                              onClick={() =>
                                workspace.id &&
                                setConfirming({
                                  ...workspace,
                                  id: workspace.id,
                                })
                              }
                            >
                              {busy === `delete:${workspace.slug}`
                                ? "Deleting…"
                                : "Delete"}
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </SettingsCard>

                <div className="flex items-center gap-2">
                  <Button onClick={() => setCreating(true)}>
                    <HugeiconsIcon
                      icon={Add01Icon}
                      strokeWidth={1.8}
                      data-icon="inline-start"
                    />
                    New project
                  </Button>
                  <Button variant="ghost" onClick={() => void hydrate()}>
                    Refresh
                  </Button>
                </div>
              </div>
            ),
          },
          {
            title: "Renaming",
            keywords: "rename name edit title change key slug",
            content: (
              // ⚠️ Here because the question a rename raises is not "how" — the
              // button is right there — but "what did I just change". The key
              // is what a folder link, a saved selection and a URL all point
              // at, and it does NOT follow the name.
              <p className="text-muted-foreground text-[13px] leading-relaxed">
                Renaming changes the name on your account, so every machine
                signed in sees it. The key underneath — the mono line above —
                never changes, which is what keeps each project's folders and
                the project you had open pointing at the right place.
              </p>
            ),
          },
        ]}
      />

      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void refresh()}
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
            <AlertDialogTitle>
              Delete {confirming?.name} from your account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the project and its cloud board from your lanework
              account, along with the folder paths every machine has reported
              for it. It cannot be undone from this app. Files on this machine
              are left exactly where they are, and another machine still syncing
              this project can put it back on its next write.
            </AlertDialogDescription>
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
