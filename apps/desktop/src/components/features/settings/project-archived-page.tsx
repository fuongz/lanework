import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import type { ArchivedAgentSession } from "#/../shared/terminal";
import type { Workspace } from "#/../shared/workspaces";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { useWorkspaceKey } from "#/hooks/use-workspace-key";
import { ipcMessage } from "#/lib/ipc-error";
import { matches } from "#/lib/settings-catalog";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useSettingsProject } from "#/stores/settings-project";
import { useSettingsSearch } from "#/stores/settings-search";

const DESCRIPTION =
  "Conversations archived from the Agents group. They are out of the rail and out of claude --resume and codex resume until you bring them back.";

function Nothing({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsCard>
  );
}

const keyOf = (entry: ArchivedAgentSession) => `${entry.agent}:${entry.id}`;

/**
 * Rows drawn at first, and how many each "Load more" adds.
 *
 * A project can have hundreds archived; drawing them all at once stalls the
 * page for rows nobody scrolls to.
 */
const PAGE = 20;

/** "May 15, 2026, 11:15 PM": when it was last written to. */
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

function Archived({ project }: { project: Workspace }) {
  const workspace = useWorkspaceKey(project.slug);
  const reload = useAgentSessions((state) => state.load);
  const [archived, setArchived] = useState<ArchivedAgentSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const query = useSettingsSearch((state) => state.query);
  /** The row whose Unarchive or Delete is waiting on main. */
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    entry: ArchivedAgentSession;
    busy: boolean;
    error: string | null;
  } | null>(null);

  // Read on entry and on focus, never on a timer: an archive changes only
  // when somebody archives, here or from a terminal.
  const read = useCallback(() => {
    const surface = window.desktop?.terminal;
    if (!surface || !workspace) return;
    surface.archivedAgentSessions(workspace).then(
      (next) => {
        setArchived(next);
        setError(null);
      },
      (failure: unknown) =>
        setError(ipcMessage(failure, "Could not read the archive.")),
    );
  }, [workspace]);

  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);

  async function unarchive(entry: ArchivedAgentSession) {
    const surface = window.desktop?.terminal;
    if (!surface || !workspace) return;
    setBusy(keyOf(entry));
    try {
      setArchived(
        await surface.unarchiveAgentSession(workspace, entry.agent, entry.id),
      );
      setError(null);
      // The rail lists it again without waiting for a focus.
      void reload(workspace);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not unarchive it."));
    } finally {
      setBusy(null);
    }
  }

  const found = (archived ?? []).filter((entry) =>
    matches(query, entry.title, "archived"),
  );
  const list = (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        {found.slice(0, shown).map((entry) => (
          <div
            key={keyOf(entry)}
            className="flex items-center justify-between gap-8 px-4 py-3.5"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium">
                {entry.title}
              </span>
              <span className="text-muted-foreground text-[13px] leading-relaxed">
                {when(entry.updatedAt)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete “${entry.title}”`}
                title="Delete"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy !== null}
                onClick={() => setDeleting({ entry, busy: false, error: null })}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </Button>
              <Button
                variant="secondary"
                className={SETTINGS_BUTTON}
                disabled={busy !== null}
                onClick={() => void unarchive(entry)}
              >
                {busy === keyOf(entry) ? "Unarchiving…" : "Unarchive"}
              </Button>
            </div>
          </div>
        ))}
      </SettingsCard>
      {found.length > shown && (
        <Button
          variant="ghost"
          className={`${SETTINGS_BUTTON} self-center`}
          onClick={() => setShown((count) => count + PAGE)}
        >
          Load more ({found.length - shown})
        </Button>
      )}
    </div>
  );

  const sections: SettingsSectionSpec[] = [];
  if (error)
    sections.push({
      title: "Error",
      hideTitle: true,
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });
  if (!project.path)
    sections.push({
      title: "No folder",
      hideTitle: true,
      keywords: "archived agents conversations folder",
      content: (
        <Nothing
          title="This project has no folder on this machine"
          description="Link a folder to see its archived conversations."
        />
      ),
    });
  else if (archived === null && !error)
    sections.push({
      title: "Reading",
      hideTitle: true,
      content: (
        <ListSkeleton
          label={`Reading ${project.name}’s archive`}
          rows={4}
          className="px-0"
        />
      ),
    });
  else if (archived && archived.length === 0)
    sections.push({
      title: "Empty",
      hideTitle: true,
      keywords: "archived agents conversations",
      content: (
        <Nothing
          title="Nothing archived"
          description="Archive a conversation from its menu in the Agents group."
        />
      ),
    });
  else if (archived)
    sections.push({
      title: "Conversations",
      hideTitle: true,
      // The titles too: the page's search keeps this section while any matches.
      keywords: `archived ${archived.map((entry) => entry.title).join(" ")}`,
      content: list,
    });

  return (
    <>
      <SettingsPage
        title="Archived"
        description={DESCRIPTION}
        sections={sections}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !deleting?.busy && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting?.entry.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its transcript is deleted from this machine for good. There is no
              undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting?.error && (
            <p role="alert" className="text-destructive text-[13px]">
              {deleting.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting?.busy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting?.busy}
              onClick={(event) => {
                // Kept open until main answers, so a refusal is shown here.
                event.preventDefault();
                const surface = window.desktop?.terminal;
                if (!deleting || !surface || !workspace) return;
                const { entry } = deleting;
                setDeleting({ entry, busy: true, error: null });
                surface
                  .deleteArchivedAgentSession(workspace, entry.agent, entry.id)
                  .then(
                    (next) => {
                      setArchived(next);
                      setDeleting(null);
                    },
                    (failure: unknown) =>
                      setDeleting({
                        entry,
                        busy: false,
                        error: ipcMessage(failure, "Could not delete it."),
                      }),
                  );
              }}
            >
              {deleting?.busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Settings › Projects › Archived: the picked project's archived Claude Code
 * and Codex conversations, each to bring back or delete for good.
 *
 * Archived from the Agents group's menu, in each CLI's own archive (FE-72/D1).
 */
export function ProjectArchivedPage() {
  const project = useSettingsProject();
  if (!project)
    return (
      <SettingsPage
        title="Archived"
        description={DESCRIPTION}
        sections={[
          {
            title: "No project",
            hideTitle: true,
            content: (
              <Nothing
                title="No projects yet"
                description="Add a project to see its archived conversations."
              />
            ),
          },
        ]}
      />
    );
  // Keyed by slug: another project's list never shows under this one.
  return <Archived key={project.slug} project={project} />;
}
