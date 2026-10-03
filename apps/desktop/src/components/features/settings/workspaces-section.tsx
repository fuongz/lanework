import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { cn } from "#/lib/utils";
import { useBoard } from "#/stores/board";
import { moveSlug, ProjectRow, shiftFor } from "./project-row";
import { SelectedProjectSection } from "./selected-project-section";

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
 * the key under Selected project's name is fixed for the life of the project —
 * which is what makes the folder link and the saved selection, both keyed by
 * slug, safe from a rename. The rename dialog says so, where the question
 * comes up (`rename-project-dialog.tsx`).
 *
 * ⚠️ Delete on this surface is not the archive the web app does. The service
 * removes the row and cascades every machine's recorded path for it, so the
 * confirmation says that rather than asking "are you sure?".
 */
export function WorkspacesSection() {
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active);
  const ready = useBoard((state) => state.ready);
  const hydrate = useBoard((state) => state.hydrate);
  const deleteProject = useBoard((state) => state.deleteProject);
  const reorderProjects = useBoard((state) => state.reorderProjects);

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

  // FE-32: the order the switcher and ⌘1…⌘9 follow. Saved by cloud id, so a
  // project the service sent no id for holds every row still.
  const canMove =
    workspaces.length > 1 && workspaces.every((entry) => entry.id !== null);
  const reorder = (slugs: string[]) => {
    setFailed(null);
    void reorderProjects(slugs).then(
      (result) => result.error && setFailed(result.error),
    );
  };
  const slugs = workspaces.map((entry) => entry.slug);
  // A small threshold, so a plain click on the grip does nothing.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  // Where the lifted row would land, so the rows it passes make room for it
  // while it is still in the air. The order itself changes only at the drop.
  const [dragging, setDragging] = useState<{
    from: number;
    to: number;
    height: number;
  } | null>(null);
  const onDragStart = (event: DragStartEvent) => {
    const from = slugs.indexOf(String(event.active.id));
    setDragging({ from, to: from, height: 0 });
  };
  const onDragOver = (event: DragOverEvent) => {
    const over = event.over ? slugs.indexOf(String(event.over.id)) : -1;
    // ⚠️ The height from here, not from `onDragStart`: dnd-kit measures the
    // lifted row only after that fires, so `rect.initial` is null there and
    // every row would step aside by 0px.
    const height = event.active.rect.current.initial?.height ?? 0;
    setDragging(
      (now) => now && { ...now, height, to: over < 0 ? now.from : over },
    );
  };
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over?.id;
    // ⚠️ The reorder and the reset in ONE render: the rows that made room are
    // already where the new order puts them, so their `y` returning to 0 and
    // their layout move cancel out instead of bouncing.
    if (over && over !== event.active.id)
      reorder(moveSlug(slugs, String(event.active.id), String(over)));
    setDragging(null);
  };
  const listRef = useRef<HTMLDivElement>(null);
  // Up and down inside the card: a row cannot be lifted out of the list.
  const alongList: Modifier = useCallback(({ transform, draggingNodeRect }) => {
    const bounds = listRef.current?.getBoundingClientRect();
    if (!bounds || !draggingNodeRect) return { ...transform, x: 0 };
    const y = Math.min(
      bounds.bottom - draggingNodeRect.bottom,
      Math.max(bounds.top - draggingNodeRect.top, transform.y),
    );
    return { ...transform, x: 0, y };
  }, []);
  // ⚠️ The project this page is MANAGING, which starts as the one that is open
  // and follows a click on a row below (FE-14). Page-local on purpose: picking
  // a project to look after is not the same as switching to it.
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    workspaces.find((workspace) => workspace.slug === picked) ??
    workspaces.find((workspace) => workspace.slug === active?.slug) ??
    workspaces[0] ??
    null;

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
            title: "Selected project",
            hideTitle: true,
            keywords:
              "selected project rename folders import danger remove all issues purge delete clear reset agent usage cost tokens",
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
              />
            ),
          },
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

                <DndContext
                  sensors={sensors}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDragEnd={onDragEnd}
                  onDragCancel={() => setDragging(null)}
                  modifiers={[alongList]}
                >
                  <SettingsCard>
                    <div ref={listRef} className="divide-border divide-y">
                      {!ready ? (
                        <p className="text-muted-foreground px-4 py-3.5 text-sm">
                          Reading your projects…
                        </p>
                      ) : workspaces.length === 0 ? (
                        <p className="text-muted-foreground px-4 py-3.5 text-sm">
                          No projects on this account yet.
                        </p>
                      ) : (
                        workspaces.map((workspace, index) => {
                          const linked = paths[workspace.slug] ?? [];
                          const isSelected = workspace.slug === selected?.slug;
                          return (
                            <ProjectRow
                              key={workspace.slug}
                              workspace={workspace}
                              index={index}
                              selected={isSelected}
                              shift={shiftFor(index, dragging)}
                              canMove={canMove}
                              onMove={(delta) => {
                                const to = slugs[index + delta];
                                if (to)
                                  reorder(moveSlug(slugs, workspace.slug, to));
                              }}
                            >
                              {/* ⚠️ The whole left side is the SELECT control, so
                              a row is picked the way a list item is — but it
                              is a real button, reachable by keyboard and named
                              for what it does. */}
                              <button
                                type="button"
                                aria-label={`Select ${workspace.name}`}
                                aria-pressed={isSelected}
                                onClick={() => setPicked(workspace.slug)}
                                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-left outline-none focus-visible:underline"
                              >
                                <span className="truncate text-sm font-medium">
                                  {workspace.name}
                                  {workspace.slug === active?.slug && (
                                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                                      open
                                    </span>
                                  )}
                                </span>
                                {/* The slug is not repeated here: it is under
                                Selected project, and a third line made every
                                row read as two keys and a path. */}
                                <span
                                  className={cn(
                                    "text-muted-foreground truncate leading-relaxed",
                                    // Mono only for a real path, not the sentence.
                                    linked.length === 0
                                      ? "text-[13px]"
                                      : "font-mono text-xs",
                                  )}
                                  title={linked.join("\n")}
                                >
                                  {linked.length === 0
                                    ? "No folder on this machine"
                                    : linked.length === 1
                                      ? linked[0]
                                      : `${linked[0]} + ${linked.length - 1} more`}
                                </span>
                              </button>
                              {workspace.slug !== active?.slug && (
                                <Button
                                  variant="ghost"
                                  aria-label={`Open ${workspace.name}`}
                                  render={
                                    <Link
                                      to="/w/$slug/issues"
                                      params={{ slug: workspace.slug }}
                                    />
                                  }
                                >
                                  Open
                                </Button>
                              )}
                            </ProjectRow>
                          );
                        })
                      )}
                    </div>
                  </SettingsCard>
                </DndContext>

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
