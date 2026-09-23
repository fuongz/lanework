import { useCallback, useEffect, useState } from "react";
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
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import type {
  ImportPreview,
  ImportReport,
  LocalFolderSummary,
  Workspace,
} from "../../../../shared/workspaces";

/** Strip Electron's IPC wrapper so a user reads the message main actually sent. */
function message(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : fallback;
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** `{ done: 9, todo: 5 }` → "9 done, 5 todo", biggest lane first. */
function tally(counts: Record<string, number>, limit = 4): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => `${n} ${key}`)
    .join(", ");
}

/** What the run did, in the one sentence a person actually needs. */
function runMessage(report: ImportReport): string {
  const parts = Object.entries(report.summary)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  // ⚠️ A failure reads as a failure ALONE. Prefixing the service's reason with
  // "Nothing to send." — which is what an empty summary produced — put a
  // sentence that was false next to the one that mattered, and the false one
  // came first.
  if (report.error)
    return parts.length
      ? `${report.error} Before it stopped: ${parts.join(", ")}.`
      : report.error;
  return parts.length ? `Sent — ${parts.join(", ")}.` : "Nothing was sent.";
}

type FolderState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "linked"; summary: LocalFolderSummary; others: string[] }
  | { kind: "missing"; path: string };

/**
 * The folder on this machine whose files still hold this workspace's cards —
 * and the way to put them on the cloud board.
 *
 * ⚠️ THREE steps, deliberately, and the middle one is not the last: read what
 * would happen, send it, and only then agree to the cutover. The cutover is
 * what puts every local writer into read-only, so it is a separate act taken
 * with the receipts already on screen. One button that migrated AND flipped the
 * switch would change a board's source of truth while somebody was still
 * reading whether it worked.
 *
 * ⚠️ Nothing here writes, moves or deletes a review file. The old copies stay
 * exactly where they are so a human can compare, which is also why re-running
 * is safe: the cloud keys every card on the file it came from.
 */
export function LocalFolderPanel({
  workspace,
  boardMigrated = false,
  onMigrated,
}: {
  workspace: Workspace;
  /**
   * Whether the CLOUD already owns this project's cards.
   *
   * ⚠️ It used to be enough that this panel only appeared on un-migrated
   * boards — the gate lived in the screen that rendered it. The panel is
   * permanently reachable now (FE-08 D14), so the gate has to live in here:
   * after a cutover the files on disk are a frozen copy, and offering to send
   * them again points somebody at the version that stopped being true.
   */
  boardMigrated?: boolean;
  /** Called after a cutover, so the board around this panel re-reads itself. */
  onMigrated?: () => void;
}) {
  const [state, setState] = useState<FolderState>({ kind: "loading" });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"folder" | "run" | "seal" | null>(null);
  const [confirming, setConfirming] = useState<"run" | "seal" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folderApi = window.desktop?.workspaces.folder;
  const boardApi = window.desktop?.workspaces.board;
  const workspaceId = workspace.id;

  const read = useCallback(async () => {
    if (!folderApi) return;
    try {
      const next = await folderApi.state(workspace.slug);
      setState(next);
      // The preview reads the folder properly — with the board's own parsers —
      // so it can only be asked for once a folder is linked AND the workspace
      // has a cloud id to import into.
      setPreview(
        next.kind === "linked" && boardApi && workspaceId
          ? await boardApi.importPreview(workspaceId)
          : null,
      );
    } catch (cause) {
      setState({ kind: "none" });
      setError(message(cause, "Could not check this workspace's folder."));
    }
  }, [folderApi, boardApi, workspace.slug, workspaceId]);

  useEffect(() => {
    void read();
  }, [read]);

  async function act(
    kind: "folder" | "run" | "seal",
    run: () => Promise<void>,
  ) {
    setBusy(kind);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(message(cause, "That did not work. Try again."));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (!folderApi || state.kind === "loading") return null;

  const canMigrate =
    state.kind === "linked" &&
    !!workspaceId &&
    !!boardApi &&
    (preview?.cards ?? 0) > 0 &&
    !preview?.blocked;
  const sealable = !!report && !report.error && !report.migratedAt;
  const migratedAt = report?.migratedAt ?? null;
  // Either this session sealed it, or it was already sealed before this window
  // opened. Both mean the same thing to everything below.
  const handedOver = boardMigrated || migratedAt !== null;

  return (
    // ⚠️ No border and no padding of its own: this panel lives inside a dialog
    // that already draws both, and two frames around one thing reads as a card
    // that failed to fill its container.
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium">
          This project on this machine
        </h3>
        <p className="text-xs text-muted-foreground">
          {state.kind === "none"
            ? // ⚠️ The account's own path is named when it has one: it is the
              // folder the user is most likely to pick, and saying it turns a
              // file chooser into a confirmation.
              workspace.path
              ? `Your account records this project at ${workspace.path}. Choose that folder to see what it holds.`
              : "Choose the folder that holds this project's .agents/reviews to see what is in it."
            : state.kind === "missing"
              ? `${state.path} is no longer on this machine.`
              : state.summary.path}
        </p>
      </div>

      {/* ⚠️ The other folders are LISTED, not counted and not read. A project
          can be created from several folders; only the primary holds the cards
          this panel is about, and a folder that was chosen at creation and then
          never appears anywhere reads as one the app forgot. */}
      {state.kind === "linked" && state.others.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium">Also in this project</p>
          <ul className="text-muted-foreground flex flex-col text-xs">
            {state.others.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.kind === "linked" && <FolderFacts summary={state.summary} />}

      {state.kind === "linked" && state.summary.cards > 0 && (
        <MigrateLines
          preview={preview}
          workspaceHasId={!!workspaceId}
          migratedAt={migratedAt}
          handedOver={handedOver}
          report={report}
        />
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act("folder", async () => {
              setState(await folderApi.pick(workspace.slug));
              setPreview(null);
              setReport(null);
              await read();
            })
          }
        >
          {busy === "folder"
            ? "Reading…"
            : state.kind === "none"
              ? "Sync from local folder"
              : "Change folder"}
        </Button>

        {canMigrate && !handedOver && (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => setConfirming("run")}
          >
            {busy === "run"
              ? "Sending…"
              : report
                ? "Send again"
                : "Sync to cloud"}
          </Button>
        )}

        {sealable && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => setConfirming("seal")}
          >
            {busy === "seal" ? "Handing over…" : "Complete cutover"}
          </Button>
        )}

        {state.kind === "linked" && state.summary.cards > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void act("folder", () => folderApi.reveal(workspace.slug))
            }
          >
            Open in file manager
          </Button>
        )}

        {state.kind !== "none" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void act("folder", async () => {
                setState(await folderApi.forget(workspace.slug));
                setPreview(null);
                setReport(null);
              })
            }
          >
            Unlink
          </Button>
        )}
      </div>

      <AlertDialog
        open={confirming === "run"}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send this project's cards to the cloud?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your review files are read, not changed — nothing is moved or
              deleted, and running this again is safe. A card that already
              exists on the board is updated in place unless somebody edited it
              in the cloud, in which case it is reported instead of overwritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void act("run", async () => {
                  if (!boardApi || !workspaceId) return;
                  setReport(await boardApi.importRun(workspaceId));
                })
              }
            >
              Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ⚠️ Destructive, because it is the one action here that cannot be undone
          from this screen: after it, the files stop being the truth and every
          local writer refuses to touch them. */}
      <AlertDialog
        open={confirming === "seal"}
        onOpenChange={(open) => !open && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make the cloud the source of truth?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The board is checked against what the run reported first. After
              that, this app and your agents read and write cards in the cloud,
              and the files under .agents/reviews are left alone — they stay on
              disk so you can compare them, but nothing writes to them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void act("seal", async () => {
                  if (!boardApi || !workspaceId) return;
                  const sealed = await boardApi.importSeal(workspaceId);
                  setReport(sealed);
                  if (sealed.migratedAt) onMigrated?.();
                })
              }
            >
              Complete cutover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * What the folder turned out to hold.
 *
 * ⚠️ Every count here comes from the card's front matter and its checklist as
 * the board's own scanner reads them. The one number that is a floor rather
 * than a total (`capped`) is labelled as one.
 */
function FolderFacts({ summary }: { summary: LocalFolderSummary }) {
  if (summary.looksUnrelated)
    return (
      <Alert>
        <AlertTitle>No Lanework project here</AlertTitle>
        <AlertDescription>
          This folder has no <code>.agents</code> directory, so it holds no
          review cards. Pick the folder that contains the repository.
        </AlertDescription>
      </Alert>
    );

  if (summary.cards === 0)
    return (
      <Alert>
        <AlertTitle>No review cards in this folder</AlertTitle>
        <AlertDescription>
          {summary.reviewRoot === null
            ? "There is an .agents directory, but no .agents/reviews to read."
            : "The review folder is there but has no cards in it yet."}
          {summary.unreadable > 0 &&
            ` ${plural(summary.unreadable, "file")} could not be read.`}
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {summary.capped ? "at least " : ""}
          {plural(summary.cards, "review card")}
        </Badge>
        {tally(summary.byStatus) && (
          <span className="text-xs text-muted-foreground">
            {tally(summary.byStatus)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {[
          summary.newest ? `newest ${summary.newest}` : "",
          tally(summary.byCategory, 3),
          summary.unreadable > 0
            ? `${plural(summary.unreadable, "file")} unreadable`
            : "",
        ]
          .filter(Boolean)
          .join(", ")}
      </p>
      {summary.capped && (
        <p className="text-xs text-muted-foreground">
          This folder has more files than one scan reads, so the counts above
          are a floor.
        </p>
      )}
    </div>
  );
}

/**
 * What sending them would do, then what it did.
 *
 * ⚠️ The lossy numbers are named BEFORE the button, not after. `inferredCheckedAt`
 * is the one quantity in a migration that is not a fact — markdown says `- [x]`
 * and never when — and a preview that only counted cards would make the import
 * look lossless.
 */
function MigrateLines({
  preview,
  workspaceHasId,
  migratedAt,
  handedOver,
  report,
}: {
  preview: ImportPreview | null;
  workspaceHasId: boolean;
  migratedAt: string | null;
  /** True when the cloud owns these cards, whoever sealed it and whenever. */
  handedOver: boolean;
  report: ImportReport | null;
}) {
  if (handedOver)
    return (
      <p className="text-xs text-muted-foreground">
        {migratedAt
          ? `The cloud has owned this project's cards since ${new Date(migratedAt).toLocaleString()}.`
          : "The cloud owns this project's cards."}{" "}
        The files are still on disk so you can compare them, and nothing writes
        to them again.
      </p>
    );

  if (!workspaceHasId)
    return (
      <p className="text-xs text-muted-foreground">
        These cards are still files. Sending them needs this workspace's cloud
        id, which this service has not sent yet — update it, then reopen this
        workspace.
      </p>
    );

  const failures = (report?.receipts ?? []).filter(
    (receipt) => receipt.status === "failed" || receipt.status === "conflict",
  );

  return (
    <div className="flex flex-col gap-1">
      {preview?.blocked ? (
        <p className="text-xs text-muted-foreground">{preview.blocked}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {[
            `${plural(preview?.cards ?? 0, "card")} and ${plural(preview?.checklistItems ?? 0, "checklist item")} would be sent`,
            (preview?.inferredCheckedAt ?? 0) > 0
              ? `${plural(preview?.inferredCheckedAt ?? 0, "ticked box")} arrive with an approximate date — the files never recorded when they were ticked`
              : "",
            (preview?.attachments ?? 0) > 0
              ? `${plural(preview?.attachments ?? 0, "linked file")} recorded as references`
              : "",
            preview?.duplicateTaskIds.length
              ? `two cards claim ${preview.duplicateTaskIds.join(", ")} — one of each pair is reported instead of imported`
              : "",
          ]
            .filter(Boolean)
            .join(", ")}
        </p>
      )}
      {report && (
        <p
          className={
            report.error
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {runMessage(report)}
        </p>
      )}
      {/* ⚠️ Surfaced by name, never swallowed. A card the service refused is one
          a person has to go and look at. */}
      {failures.length > 0 && (
        <p className="text-xs text-destructive">
          Not imported:{" "}
          {failures
            .slice(0, 4)
            .map(
              (receipt) =>
                `${receipt.ref} (${receipt.error ?? receipt.status})`,
            )
            .join(", ")}
          {failures.length > 4 ? `, and ${failures.length - 4} more.` : "."}
        </p>
      )}
      {preview?.problems.map((problem) => (
        <p key={problem.path} className="text-xs text-destructive">
          {problem.path || "this project"}: {problem.reason}
        </p>
      ))}
    </div>
  );
}
