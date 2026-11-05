import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type {
  OriginScan,
  PickedFolder,
  ProjectDestination,
  RepoChoice,
} from "#/../shared/projects";
import {
  PrimaryFolderHint,
  SourceFolders,
} from "#/components/shared/projects/source-folders";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import { ipcMessage } from "#/lib/ipc-error";
import { useBoard } from "#/stores/board";

/** The select's value for Local; a repo row's value is its `host/owner/name`. */
const LOCAL = "local";

/** What choosing `choice` would do, in the words its row shows. */
function describe(
  choice: RepoChoice,
  canLink: boolean,
): { title: string; detail: string; disabled: boolean } {
  if (!canLink)
    return {
      title: `Link ${choice.repo}`,
      detail: "Sign in to link a repo",
      disabled: true,
    };
  const boards = choice.boards;
  if (boards && boards.length > 1)
    return {
      title: choice.repo,
      detail: `Linked to ${boards.length} boards. Keep it on one first`,
      disabled: true,
    };
  const [board] = boards ?? [];
  if (board)
    return {
      title: `Open ${board.name}`,
      detail: `The board ${choice.repo} is linked to`,
      disabled: false,
    };
  return {
    title: `Link ${choice.repo}`,
    detail:
      boards === null
        ? "Its boards could not be checked; checked again on create"
        : "A new cloud board, linked to this repo",
    disabled: false,
  };
}

/**
 * The picked folders' git origins, read again whenever the folders change
 * (FE-121). A slower answer for an older list is dropped.
 */
function useOriginScan(folders: PickedFolder[]) {
  const [scan, setScan] = useState<OriginScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const latest = useRef(0);
  const key = folders.map((folder) => folder.id).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `folders`; `round` is Retry.
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    const ticket = ++latest.current;
    setFailed(null);
    if (!ids.length) {
      setScan(null);
      setScanning(false);
      return;
    }
    const api = window.desktop?.projects.folder;
    if (!api) return;
    setScanning(true);
    api.origins(ids).then(
      (result) => {
        if (ticket !== latest.current) return;
        setScan(result);
        setScanning(false);
      },
      (cause) => {
        if (ticket !== latest.current) return;
        setScan(null);
        setScanning(false);
        setFailed(ipcMessage(cause, "Could not read these folders' repos."));
      },
    );
  }, [key, round]);

  return { scan, scanning, failed, retry: () => setRound((n) => n + 1) };
}

/**
 * The dialog that creates a project from a name and its source folders.
 *
 * - One implementation, two doors: the project switcher and the empty
 *   account. Two copies would be two places to keep a refusal message, a
 *   disabled state and the folder list in step.
 * - It asks for a name, not a slug. The service refuses to derive one, so
 *   main does it (`slug.ts`); asking a person for `du-an-cua-toi` is asking
 *   them to do a computer's job in a field where a typo is permanent.
 * - NOTE: Folders are carried as ids the chooser minted, never as paths. The
 *   path is shown only to be read (basenames cannot tell two checkouts of one
 *   repo apart). Main resolves the ids against folders it opened itself, so
 *   this window cannot name a folder nobody picked.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<PickedFolder[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  // FE-121/D3: Local until the user picks a repo, even when there is one.
  const [where, setWhere] = useState<string>(LOCAL);
  const origins = useOriginScan(folders);
  const repos = origins.scan?.repos ?? [];
  const canLink = origins.scan?.canLink ?? false;
  const chosen = repos.find((choice) => choice.repo === where) ?? null;
  const opening =
    chosen && canLink && chosen.boards?.length === 1 ? chosen.boards[0] : null;
  const unread = origins.scan?.folders.filter(
    (folder) => folder.status === "error",
  );
  const busy = useBoard((state) => state.busy);
  const createProject = useBoard((state) => state.createProject);
  const working = busy === "project";

  function close(next: boolean) {
    onOpenChange(next);
    // Cleared on the way out, not on the way in. A dialog that reset while it
    // was still fading away would show the name and folders being wiped,
    // which reads as the create having failed.
    if (!next) {
      setName("");
      setFolders([]);
      setFailed(null);
      setWhere(LOCAL);
    }
  }

  // A repo row that went away with its folders falls back to Local.
  if (where !== LOCAL && !origins.scanning && !chosen) setWhere(LOCAL);

  function submit() {
    const typed = name.trim();
    if (!typed && !opening) return;
    setFailed(null);
    const destination: ProjectDestination = chosen
      ? { kind: "repo", repo: chosen.repo }
      : { kind: "local" };
    void createProject(
      typed,
      folders.map((folder) => folder.id),
      destination,
    ).then((result) => {
      // Everything typed is kept when creation fails. "That key is taken" is
      // an invitation to edit the name, not to pick three folders again.
      if ("error" in result) {
        setFailed(result.error);
        // A cloud project may exist even so (created, then not linked).
        if (chosen) void useBoard.getState().hydrate();
        return;
      }
      close(false);
      if (result.project) onCreated(result.project.slug);
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Name it, and add the folders on this machine it is built from.
          </DialogDescription>
        </DialogHeader>

        <form
          // NOTE: `min-w-0`, because the dialog is a grid and a grid item
          // defaults to `min-width: auto`. A folder path with no spaces then
          // stretches the form past the popup and the rows paint outside the
          // card. Truncation cannot start until something may be narrower
          // than its content.
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <InputGroup className="h-9">
            <InputGroupAddon>
              <HugeiconsIcon
                icon={Folder01Icon}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </InputGroupAddon>
            <InputGroupInput
              // NOTE: Tests and users reach for this accessible name; keep it.
              aria-label="New project name"
              placeholder="Project name"
              value={name}
              maxLength={200}
              disabled={working}
              autoFocus
              className="h-9 text-[13px] md:text-[13px]"
              onChange={(event) => setName(event.target.value)}
            />
          </InputGroup>

          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-[13px] font-medium">Source folders</h3>
            <SourceFolders
              folders={folders}
              onChange={setFolders}
              onError={setFailed}
              disabled={working}
            />
            <PrimaryFolderHint folders={folders} />
          </div>

          {folders.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 id="project-where" className="text-[13px] font-medium">
                Where this project lives
              </h3>
              {origins.scanning && !origins.scan ? (
                <Skeleton className="h-8 w-full rounded-md" />
              ) : (
                <Select
                  value={where}
                  onValueChange={(value) => setWhere(String(value))}
                  disabled={working || repos.length === 0}
                >
                  <SelectTrigger
                    aria-labelledby="project-where"
                    className="w-full"
                  >
                    <SelectValue>
                      {(value: string) =>
                        value === LOCAL
                          ? "Local, saved on this machine only"
                          : (() => {
                              const row = repos.find(
                                (choice) => choice.repo === value,
                              );
                              return row
                                ? describe(row, canLink).title
                                : "Local, saved on this machine only";
                            })()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={LOCAL}>
                      <span className="flex flex-col">
                        <span>Local</span>
                        <span className="text-muted-foreground">
                          Saved on this machine only
                        </span>
                      </span>
                    </SelectItem>
                    {repos.map((choice) => {
                      const row = describe(choice, canLink);
                      return (
                        <SelectItem
                          key={choice.repo}
                          value={choice.repo}
                          disabled={row.disabled}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{row.title}</span>
                            <span className="text-muted-foreground truncate">
                              {row.detail}
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
              {origins.failed ? (
                <p role="alert" className="text-destructive text-xs">
                  {origins.failed}{" "}
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0"
                    onClick={origins.retry}
                  >
                    Try again
                  </Button>
                </p>
              ) : unread?.length ? (
                // FE-121/D7: a folder git could not read is not a folder
                // with no repo. Said per folder, with Retry; Local stays a
                // choice the user makes.
                <div role="alert" className="text-destructive text-xs">
                  {unread.map((folder) => (
                    <p key={folder.id} className="break-words">
                      {folder.name}: {folder.error}
                    </p>
                  ))}
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0"
                    onClick={origins.retry}
                  >
                    Read again
                  </Button>
                </div>
              ) : (
                origins.scan && (
                  <p className="text-muted-foreground text-xs">
                    {repos.length === 0
                      ? "No git origin in these folders, so the board stays on this machine. You can link a repo later."
                      : opening
                        ? `Opens ${opening.name} and adds these folders to it on this machine.`
                        : chosen
                          ? "The other folders stay in the project. Only this repo is linked."
                          : canLink
                            ? "Pick a repo to keep the board in the cloud, or keep it on this machine."
                            : "Sign in to link a repo. The board can move to the cloud later."}
                  </p>
                )
              )}
            </div>
          )}

          {failed && (
            <p role="alert" className="text-destructive text-xs">
              {failed}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={working}
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={
                (!name.trim() && !opening) || working || origins.scanning
              }
            >
              {working
                ? opening
                  ? "Opening…"
                  : "Creating…"
                : opening
                  ? "Open project"
                  : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
