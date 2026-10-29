import {
  DashboardSquare02Icon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  RefreshIcon,
  SecurityBlockIcon,
  SecurityCheckIcon,
  StopCircleIcon,
  TaskRemove01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import type { FolderTrust, SetupAgent } from "#/../shared/agent-setup";
import type { ReadinessFix } from "#/../shared/readiness";
import type { Workspace } from "#/../shared/workspaces";
import type { RepoTrust } from "#/../shared/worktree";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SETTINGS_BUTTON,
  SettingsCard,
} from "#/components/shared/settings/settings-page";
import {
  type TrustAsk,
  TrustDialog,
} from "#/components/shared/settings/trust-dialog";
import {
  useProjectTrust,
  useRepoTrust,
} from "#/components/shared/settings/use-project-trust";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { ProjectTile } from "#/components/shared/workspaces/project-tile";
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
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { useBoard } from "#/stores/board";
import { useReadiness, useReadinessWatch } from "#/stores/readiness";
import { ReadinessFixDialog } from "./readiness-fix-dialog";
import { ReadinessList } from "./readiness-list";

/** One row of the section's card: what it is on the left, the action right. */
export function Row({
  leading,
  label,
  description,
  children,
}: {
  /** Drawn before the label: the project's avatar on its own row. */
  leading?: React.ReactNode;
  label: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="text-muted-foreground text-[13px] leading-relaxed">
            {description}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Every readiness check for one project, passed ones included.
 *
 * For any project, not only the open one. This is the only place readiness is
 * shown: nothing on the board or in the sidebar asks for it.
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
  const [fix, setFix] = useState<ReadinessFix | null>(null);
  // Asked again when the folders change: linking one is the fix for the
  // first check, and its result should not wait for the next focus.
  useReadinessWatch(slug, folders.join("\n"));

  return (
    <div className="mt-9 flex flex-col gap-3">
      <h3 className="text-[15px] font-medium">Ready for agents</h3>
      <SettingsCard className="px-4 py-1">
        {report ? (
          <ReadinessList
            report={report}
            onFix={setFix}
            className="divide-border divide-y"
          />
        ) : error ? (
          <p className="text-muted-foreground py-3 text-[13px]">{error}</p>
        ) : (
          <ListSkeleton
            label="Checking this project’s folder"
            rows={4}
            className="px-0"
          />
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

/** What a CLI's trust in the folder means for its chats, in words. */
function trustText(agent: SetupAgent, trust: FolderTrust): string {
  const config = agent === "claude" ? ".claude settings" : ".codex config";
  const load = agent === "claude" ? "load" : "loads";
  if (trust.from)
    return `Trusted through ${trust.from}, so the repository’s ${config} ${load} here. Untrust it there to stop that.`;
  if (trust.trusted) return `Trusted: the repository’s ${config} ${load}.`;
  if (trust.own === false)
    return `Not trusted: chats run without the repository’s ${config}.`;
  return `Not trusted yet: chats run without the repository’s ${config}.`;
}

/** A Folder trust row's mark: the agent's own, or git's, on a tile. */
function TrustMark({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      {children}
    </span>
  );
}

/** A Folder trust button's icon, drawn as the other settings buttons'. */
function ButtonIcon({
  icon,
  destructive = false,
}: {
  icon: typeof RefreshIcon;
  destructive?: boolean;
}) {
  return destructive ? (
    <HugeiconsIcon icon={icon} className="size-4" strokeWidth={2} />
  ) : (
    <HugeiconsIcon icon={icon} strokeWidth={1.5} data-icon="inline-start" />
  );
}

/** What the repository's git settings run, as a short list in words. */
function programs(findings: string[]): string {
  if (findings.length <= 2) return findings.join(" and ");
  return `${findings.slice(0, 2).join(", ")} and ${findings.length - 2} more`;
}

/** Lanework's own git gate for the repository, in words (FE-102). */
function gitTrustText(trust: RepoTrust): string {
  const run = programs(trust.findings);
  switch (trust.state) {
    case "safe":
      return "Nothing in the repository’s git settings runs a program.";
    case "allowed":
      return `Lanework reads the repository, and its git settings run ${run}.`;
    case "refused":
      return `Lanework does not read the repository: its git settings run ${run}.`;
    case "unasked":
      return `Its git settings run ${run}. Lanework asks before it reads them.`;
    case "unchecked":
      return "Lanework could not check the repository’s git settings.";
    case "none":
      return "";
  }
}

/**
 * The Git settings row: Lanework's own reads of the repository (FE-77/D6),
 * answered again from here (FE-102). Ask again opens the native prompt;
 * Stop running answers "Don't run" without one.
 */
function GitTrustRow({ slug }: { slug: string }) {
  const { trust, busy, run } = useRepoTrust(slug);
  if (!trust || trust.state === "none") return null;
  return (
    <Row
      leading={
        <TrustMark>
          <HugeiconsIcon
            icon={GitBranchIcon}
            className="size-4.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </TrustMark>
      }
      label="Git settings"
      description={
        <span title={trust.findings.join("\n") || undefined}>
          {gitTrustText(trust)}
        </span>
      }
    >
      {trust.state === "allowed" ? (
        <Button
          size="lg"
          className={`${SETTINGS_BUTTON} border-0`}
          variant="destructive"
          disabled={busy}
          onClick={() => void run("restrict")}
        >
          <ButtonIcon icon={StopCircleIcon} destructive />
          Stop running
        </Button>
      ) : trust.state === "refused" || trust.state === "unasked" ? (
        <Button
          size="lg"
          className={SETTINGS_BUTTON}
          variant="outline"
          disabled={busy}
          onClick={() => void run("ask")}
        >
          <ButtonIcon icon={RefreshIcon} />
          {trust.state === "refused" ? "Ask again" : "Ask now"}
        </Button>
      ) : trust.state === "unchecked" ? (
        <Button
          size="lg"
          className={SETTINGS_BUTTON}
          variant="outline"
          disabled={busy}
          onClick={() => void run("read")}
        >
          <ButtonIcon icon={RefreshIcon} />
          Try again
        </Button>
      ) : null}
    </Row>
  );
}

/**
 * Whether Claude Code and Codex trust the project's folder, with the user's
 * answer changed here (FE-101): Trust when it is not, Untrust when its own
 * record is what trusts it. A trust from a folder above is said, not offered
 * to take back: untrusting this folder would not end it.
 */
function TrustSection({ slug }: { slug: string }) {
  const { trust, error, busy, set } = useProjectTrust(slug);
  const [ask, setAsk] = useState<TrustAsk | null>(null);
  if (trust && !trust.folder) return null;

  return (
    <div className="mt-9 flex flex-col gap-3">
      <h3 className="text-[15px] font-medium">Folder trust</h3>
      <SettingsCard>
        {trust ? (
          (["claude", "codex"] as const).map((agent) => {
            const state = trust[agent];
            const name = agent === "claude" ? "Claude Code" : "Codex";
            return (
              <Row
                key={agent}
                leading={
                  <TrustMark>
                    <TerminalKindIcon kind={agent} className="size-4.5" />
                  </TrustMark>
                }
                label={name}
                description={trustText(agent, state)}
              >
                {!state.trusted ? (
                  <Button
                    size="lg"
                    className={SETTINGS_BUTTON}
                    variant="outline"
                    aria-label={`Trust this folder for ${name}`}
                    disabled={busy !== null}
                    onClick={() => setAsk({ agent, on: true })}
                  >
                    <ButtonIcon icon={SecurityCheckIcon} />
                    {busy === agent ? "Trusting…" : "Trust"}
                  </Button>
                ) : state.from === null ? (
                  <Button
                    size="lg"
                    className={`${SETTINGS_BUTTON} border-0`}
                    variant="destructive"
                    aria-label={`Untrust this folder for ${name}`}
                    disabled={busy !== null}
                    onClick={() => setAsk({ agent, on: false })}
                  >
                    <ButtonIcon icon={SecurityBlockIcon} destructive />
                    {busy === agent ? "Untrusting…" : "Untrust"}
                  </Button>
                ) : null}
              </Row>
            );
          })
        ) : (
          <ListSkeleton label="Reading the folder’s trust" rows={2} />
        )}
        {trust && <GitTrustRow slug={slug} />}
      </SettingsCard>
      {error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {error}
        </p>
      )}
      <TrustDialog
        ask={ask}
        folder={trust?.folder ?? null}
        onClose={() => setAsk(null)}
        onConfirm={(request) => {
          setAsk(null);
          void set(request.agent, request.on);
        }}
      />
    </div>
  );
}

/**
 * Everything that can be done to one project, gathered in one place.
 *
 * - The project is the one picked in the sidebar's Projects heading, which
 *   starts as the open one. Managing another project does not mean leaving
 *   Settings to open it first.
 * - The two irreversible actions sit apart, under "Danger zone", and each
 *   confirmation says what goes and what stays. "Remove all issues" asks for
 *   the project's key typed out: the button is one click from a board that
 *   took months to fill, and a click is not a decision.
 */
export function SelectedProjectSection({
  workspace,
  folders,
  onRename,
  onFolders,
  onImport,
  onDelete,
  onFailed,
  extraRows,
  dangerRows,
}: {
  workspace: Workspace | null;
  folders: string[];
  onRename: (workspace: Workspace & { id: string }) => void;
  onFolders: (workspace: Workspace) => void;
  onImport: (workspace: Workspace) => void;
  onDelete: (workspace: Workspace & { id: string }) => void;
  onFailed: (message: string | null) => void;
  /** More rows for the project's card: Sync to cloud, for a local one. */
  extraRows?: React.ReactNode;
  /** More rows for Danger zone, above its own: the repository's Disconnect. */
  dangerRows?: React.ReactNode;
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
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={DashboardSquare02Icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Create one to see its settings here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const id = workspace.id;
  const noId =
    "This project has no cloud ID yet, so it cannot be changed here.";
  // A count only when it is known, from the open board's list read. For any
  // other project the dialog says "every issue" rather than a number this
  // page never read.
  const count =
    active?.slug === workspace.slug && view
      ? (view.total ?? view.cards.length)
      : null;
  const working = busy === `purge:${workspace.slug}`;

  // The same rhythm as `SettingsPage` (`gap-2.5`, then `mt-9` and `gap-3` per
  // heading), so "Ready for agents" and "Danger zone" read as sections of the
  // page, spaced like "On this account" below them.
  return (
    <div className="flex flex-col gap-2.5">
      <SettingsCard>
        <Row
          leading={
            <ProjectTile workspace={workspace} className="size-9 text-sm" />
          }
          label={workspace.name}
          description={
            <span className="font-mono text-xs">{workspace.slug}</span>
          }
        >
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
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
            size="lg"
            className={SETTINGS_BUTTON}
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
          description="Bring the folder's review cards onto the board."
        >
          {/* Not disabled without a cloud id, unlike Rename and Delete: the
              panel still reads the folder and says what is in it, the one
              place that answers "where did my cards go?". */}
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            aria-label={`Import from local into ${workspace.name}`}
            onClick={() => onImport(workspace)}
          >
            Import from local
          </Button>
        </Row>
        {extraRows}
      </SettingsCard>

      <ReadinessSection slug={workspace.slug} folders={folders} />

      <TrustSection slug={workspace.slug} />

      <div className="mt-9 flex flex-col gap-3">
        <h3 className="text-destructive text-[15px] font-medium">
          Danger zone
        </h3>
        <SettingsCard>
          {dangerRows}
          <Row
            label="Remove all issues"
            description={
              removed !== null
                ? `Removed ${removed} ${removed === 1 ? "issue" : "issues"}. The board is empty.`
                : "Delete every issue, with its comments and history. The project stays."
            }
          >
            <Button
              size="lg"
              className={`${SETTINGS_BUTTON} border-0`}
              variant="destructive"
              // The same tinted pill as Account → Sign out, and its
              // `border-0` for the same reason (see `account-section.tsx`).
              aria-label={`Remove all issues in ${workspace.name}`}
              disabled={!id || working}
              title={id ? undefined : noId}
              onClick={() => {
                setTyped("");
                setPurging(true);
              }}
            >
              <HugeiconsIcon
                icon={TaskRemove01Icon}
                className="size-4"
                strokeWidth={2}
              />
              {working ? "Removing…" : "Remove all issues"}
            </Button>
          </Row>
          <Row
            label="Delete project"
            description="Delete the project and its board."
          >
            <Button
              size="lg"
              className={`${SETTINGS_BUTTON} border-0`}
              variant="destructive"
              aria-label={`Delete ${workspace.name}`}
              disabled={!id || busy === `delete:${workspace.slug}`}
              title={id ? undefined : noId}
              onClick={() => id && onDelete({ ...workspace, id })}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                className="size-4"
                strokeWidth={2}
              />
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
              // NOTE: The exact key, not a case-insensitive match. The service
              // checks the same string, so what enables the button is what the
              // request will be accepted with.
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
