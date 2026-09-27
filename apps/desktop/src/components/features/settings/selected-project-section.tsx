import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useState } from "react";
import type { ReadinessFix } from "#/../shared/readiness";
import type { Workspace } from "#/../shared/workspaces";
import { ReadinessFixDialog } from "#/components/shared/readiness/readiness-fix-dialog";
import { ReadinessList } from "#/components/shared/readiness/readiness-list";
import { SettingsCard } from "#/components/shared/settings/settings-page";
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
import { Input } from "#/components/ui/input";
import { useBoard } from "#/stores/board";
import { useReadiness } from "#/stores/readiness";

/** One row of the section's card: what it is on the left, the action on the right. */
function Row({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-[13px] leading-relaxed">
          {description}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Every readiness check for one project (FE-30), passed ones included — the
 * full list behind the indicator beside the switcher, for ANY project here,
 * not only the open one.
 */
function ReadinessSection({
  slug,
  folders,
}: {
  slug: string;
  folders: string[];
}) {
  const report = useReadiness((state) => state.reports[slug]);
  const error = useReadiness((state) => state.errors[slug]);
  const check = useReadiness((state) => state.check);
  const [fix, setFix] = useState<ReadinessFix | null>(null);
  // Asked again when the folders change: linking one is the fix for the
  // first check, and its result should not wait for the next focus.
  const key = folders.join("\n");
  useEffect(() => {
    void key;
    void check(slug);
  }, [check, slug, key]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Ready for agents
      </h3>
      <SettingsCard className="px-4 py-1">
        {report ? (
          <ReadinessList
            report={report}
            onFix={setFix}
            className="divide-border divide-y"
          />
        ) : (
          <p className="text-muted-foreground py-3 text-[13px]">
            {error ?? "Checking this project’s folder…"}
          </p>
        )}
      </SettingsCard>
      <ReadinessFixDialog
        slug={slug}
        fix={fix}
        onOpenChange={(open) => !open && setFix(null)}
      />
    </div>
  );
}

/**
 * Everything that can be done to ONE project, gathered in one place (FE-14).
 *
 * ⚠️ The project is the one SELECTED on this page, which starts as the one that
 * is open. Managing a different project does not mean leaving Settings to open
 * it first — picking its row in the list below is enough.
 *
 * ⚠️ The two irreversible actions sit apart, under "Danger zone", and each has
 * a confirmation that says what goes and what stays. "Remove all issues" asks
 * for the project's key typed out: the button is one click from a board that
 * took months to fill, and a click is not a decision.
 */
export function SelectedProjectSection({
  workspace,
  folders,
  onRename,
  onFolders,
  onImport,
  onDelete,
  onFailed,
}: {
  workspace: Workspace | null;
  folders: string[];
  onRename: (workspace: Workspace & { id: string }) => void;
  onFolders: (workspace: Workspace) => void;
  onImport: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace & { id: string }) => void;
  onFailed: (message: string | null) => void;
}) {
  const busy = useBoard((state) => state.busy);
  const active = useBoard((state) => state.active);
  const view = useBoard((state) => state.view);
  const purgeIssues = useBoard((state) => state.purgeIssues);
  const [purging, setPurging] = useState(false);
  const [typed, setTyped] = useState("");
  const [removed, setRemoved] = useState<number | null>(null);
  const confirmId = useId();

  if (!workspace)
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>No project selected</EmptyTitle>
          <EmptyDescription>
            Pick one in the list below to manage it here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const id = workspace.id;
  const noId =
    "This project has no cloud id yet, so it cannot be changed from here.";
  // ⚠️ A count only when it is known: the open board's list read. For any
  // other project the dialog says "every issue" rather than a number this page
  // never read.
  const count =
    active?.slug === workspace.slug && view
      ? (view.total ?? view.cards.length)
      : null;
  const working = busy === `purge:${workspace.slug}`;

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <Row
          label={workspace.name}
          description={
            <span className="font-mono text-xs">{workspace.slug}</span>
          }
        >
          <Button
            variant="ghost"
            aria-label={`Rename ${workspace.name}`}
            disabled={!id || busy === `rename:${id}`}
            title={id ? undefined : noId}
            onClick={() => id && onRename({ ...workspace, id })}
          >
            {busy === `rename:${id}` ? "Saving…" : "Rename"}
          </Button>
        </Row>
        <Row
          label="Folders on this machine"
          description={
            <span title={folders.join("\n")}>
              {folders.length === 0
                ? "No folder on this machine"
                : folders.length === 1
                  ? folders[0]
                  : `${folders[0]} + ${folders.length - 1} more`}
            </span>
          }
        >
          <Button
            variant="outline"
            aria-label={`Source folders for ${workspace.name}`}
            onClick={() => onFolders(workspace)}
          >
            <HugeiconsIcon
              icon={Folder01Icon}
              strokeWidth={1.5}
              data-icon="inline-start"
            />
            Folders
          </Button>
        </Row>
        <Row
          label="Import from local"
          description="Bring the review cards in this project's folder onto its cloud board."
        >
          {/* ⚠️ NOT disabled without a cloud id, unlike Rename and Delete: the
              panel still reads the folder and says what is in it, which is the
              one place that answers "where did my cards go?". */}
          <Button
            variant="ghost"
            aria-label={`Import from local into ${workspace.name}`}
            onClick={() => onImport(workspace)}
          >
            Import from local
          </Button>
        </Row>
      </SettingsCard>

      <ReadinessSection slug={workspace.slug} folders={folders} />

      <div className="flex flex-col gap-2">
        <h3 className="text-destructive text-xs font-medium tracking-wide uppercase">
          Danger zone
        </h3>
        <SettingsCard>
          <Row
            label="Remove all issues"
            description={
              removed !== null
                ? `Removed ${removed} ${removed === 1 ? "issue" : "issues"}. The board is empty and ready for a fresh import.`
                : "Permanently delete every issue on this board — checklists, comments and history included. The project, its lanes, categories and members stay."
            }
          >
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              aria-label={`Remove all issues in ${workspace.name}`}
              disabled={!id || working}
              title={id ? undefined : noId}
              onClick={() => {
                setTyped("");
                setPurging(true);
              }}
            >
              {working ? "Removing…" : "Remove all issues"}
            </Button>
          </Row>
          <Row
            label="Delete project"
            description="Remove the project and its cloud board from your account."
          >
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              aria-label={`Delete ${workspace.name}`}
              disabled={!id || busy === `delete:${workspace.slug}`}
              title={id ? undefined : noId}
              onClick={() => id && onDelete({ ...workspace, id })}
            >
              {busy === `delete:${workspace.slug}` ? "Deleting…" : "Delete"}
            </Button>
          </Row>
        </SettingsCard>
      </div>

      <AlertDialog
        open={purging}
        onOpenChange={(open) => !open && setPurging(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {count === null ? "every issue" : `all ${count} issues`} in{" "}
              {workspace.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every card on this board is deleted for good, archived ones too,
              with their checklists, comments and history. There is no undo. The
              project, its lanes, categories and members stay, and task ids
              start again from 01. Review files on this machine are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5 text-[13px]">
            <label htmlFor={confirmId}>
              Type{" "}
              <span className="font-mono font-medium">{workspace.slug}</span> to
              confirm.
            </label>
            <Input
              id={confirmId}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="border-0"
              // ⚠️ Exactly the key, not a case-insensitive match: it is the
              // same string the service checks, so what enables the button is
              // what the request will be accepted with.
              disabled={typed !== workspace.slug || !id}
              onClick={() => {
                if (!id || typed !== workspace.slug) return;
                setPurging(false);
                onFailed(null);
                setRemoved(null);
                void purgeIssues(id, workspace.slug).then((result) => {
                  if (result.error) onFailed(result.error);
                  else setRemoved(result.deleted ?? 0);
                });
              }}
            >
              {count === null
                ? "Remove every issue"
                : `Remove ${count} ${count === 1 ? "issue" : "issues"} permanently`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
