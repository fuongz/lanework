// The local-repository channels.
//
// NOTE: Every one of them takes a SLUG and resolves the folder here, from
// what this machine wrote down: the same rule `repoState` follows for the
// remote. No channel accepts a directory.
import { stat } from "node:fs/promises";
import { shell } from "electron";
import {
  type BranchList,
  type CommitChange,
  type CommitHistory,
  type CommitMode,
  type FileListing,
  type FileSide,
  type FileView,
  type HeldRead,
  LAUNCHABLE,
  opensInDefaultApp,
  type RepoTrust,
  type SyncAction,
  type WorktreePatch,
  type WorktreeState,
  worktreeChannels,
} from "../../../shared/worktree";
import { handle as handleIpc } from "../ipc";
import { knownProject } from "../projects";
import { readFolders } from "../projects/store";
import type { TrustFinding } from "./repo-trust";
import { askAgain, restrictTrust, trustState } from "./trust-gate";
import {
  assertReadable,
  branches,
  commit,
  fileText,
  listDir,
  listFiles,
  locate,
  locateFile,
  locateInRepo,
  log,
  patch,
  ReadsRefusedError,
  restore,
  show,
  stage,
  status,
  switchBranch,
  sync,
  unstage,
  viewFile,
} from "./worktree";

/**
 * Register a worktree handler: a read the git gate held back is answered as
 * a {@link HeldRead}, not thrown, so Electron does not log an expected
 * refusal on every read (FE-102). The preload makes it an error again.
 */
function handle<T>(
  channel: string,
  devUrl: string | undefined,
  handler: (args: unknown[]) => T | Promise<T>,
): void {
  handleIpc(channel, devUrl, async (args): Promise<T | HeldRead> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ReadsRefusedError) return { heldRead: error.reason };
      throw error;
    }
  });
}

/** One finding as the trust prompt lists it. */
function findingText(finding: TrustFinding): string {
  if (finding.kind === "hook") return `Hook: ${finding.name}`;
  const value =
    finding.value.length > 120
      ? `${finding.value.slice(0, 117)}...`
      : finding.value;
  return `${finding.key} = ${value}`;
}

/** Where the repository's git settings stand, read without asking. */
async function repoTrust(slug: string, folder = 0): Promise<RepoTrust> {
  const found = await repo(slug, folder);
  if ("state" in found) return { state: "none", findings: [] };
  const { state, findings } = await trustState(found.top);
  return { state, findings: findings.map(findingText) };
}

/**
 * Folder `index` of the project `slug`, as this machine linked it.
 *
 * NOTE: Resolved through {@link knownProject}, which knows local boards.
 * A plain `authorizedRecord` refuses every project in local mode, where a
 * local board files its folders under no credential.
 */
async function folderAt(slug: string, index: number): Promise<string | null> {
  const { record, project } = await knownProject(slug);
  return (await readFolders(record))[project.slug]?.[index] ?? null;
}

/**
 * A project's slug from the renderer, checked.
 *
 * @throws When it is not a non-empty string of at most 200 characters.
 */
function slugOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required.");
  return value;
}

/** The sync actions the renderer may ask for. */
const SYNC_ACTIONS: SyncAction[] = [
  "fetch",
  "pull",
  "pull-rebase",
  "push",
  "force-push",
];

/**
 * The most paths one call takes.
 *
 * Enough for a "Stage All" on a big refactor, not more.
 */
const MAX_PATHS = 5_000;

/**
 * The paths a stage, unstage or restore acts on, checked.
 *
 * @throws When there are none, too many, or one is not a valid path.
 */
function pathsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS)
    throw new Error("Choose at least one file.");
  return value.map((path) => {
    if (typeof path !== "string" || !path || path.length > 4_096)
      throw new Error("That is not a file in this repository.");
    return path;
  });
}

/**
 * Which side of a file to read: the working tree, or a revision.
 *
 * @throws When it is neither.
 */
function sideOf(value: unknown): FileSide {
  const side = value as FileSide | null;
  if (side?.kind === "worktree") return { kind: "worktree" };
  if (
    side?.kind === "rev" &&
    typeof side.rev === "string" &&
    side.rev.length <= 80
  )
    return { kind: "rev", rev: side.rev };
  throw new Error("That is not a side of a file.");
}

/**
 * Which of the project's linked folders a call is for, by index.
 *
 * The primary folder (0) when absent (FE-71/D3). Only the Files channels and
 * `status` take one.
 *
 * @throws When it is not an index from 0 to 255.
 */
function folderOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  )
    throw new Error("That is not one of this project's folders.");
  return value;
}

/** The repository's top level, or the state that says why there is none. */
async function repo(
  slug: string,
  folder = 0,
): Promise<{ top: string } | { state: WorktreeState }> {
  const path = await folderAt(slug, folder);
  const found = await locate(path);
  return found.kind === "ready" ? { top: found.top } : { state: found };
}

/**
 * The repository's top level.
 *
 * For a write the user asked for, and for the Files reads that never run
 * `git` past finding the top. Anything else the app reads on its own goes
 * through {@link readable}.
 *
 * @throws When the folder has no local repository.
 */
async function top(slug: string, folder = 0): Promise<string> {
  const found = await repo(slug, folder);
  if ("state" in found)
    throw new Error("This project has no local repository to read.");
  return found.top;
}

/**
 * The repository's top level, once its automatic reads are allowed (FE-77,
 * D6).
 *
 * @throws When the folder has no local repository.
 * @throws {ReadsRefusedError} When the user chose not to let the folder's git
 *   settings run.
 */
async function readable(slug: string, folder = 0): Promise<string> {
  const path = await top(slug, folder);
  await assertReadable(path);
  return path;
}

/**
 * The repository's status, or the state that says why there is none.
 *
 * NOTE: Read on project open, on focus, and for the rail's badges: the
 * automatic read the trust prompt exists for. A refusal is thrown, and the
 * Changes screen shows it as its error; the badge stays empty.
 */
async function current(slug: string, folder = 0): Promise<WorktreeState> {
  const found = await repo(slug, folder);
  if ("state" in found) return found.state;
  await assertReadable(found.top);
  return status(found.top);
}

/**
 * A path inside the repository, as the Files screen names one.
 *
 * @throws When it is not a non-empty string of at most 4096 characters.
 */
function pathOf(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096)
    throw new Error("That is not a file in this repository.");
  return value;
}

/** Register the local-repository IPC handlers. */
export function registerWorktree(devUrl?: string): void {
  // Repository › Files. Read-only: listing, reading, and Finder.
  handle(
    worktreeChannels.files,
    devUrl,
    async (args): Promise<FileListing> =>
      listFiles(await readable(slugOf(args[0]), folderOf(args[1]))),
  );

  handle(
    worktreeChannels.dir,
    devUrl,
    async (args): Promise<FileListing> =>
      listDir(await top(slugOf(args[0]), folderOf(args[2])), pathOf(args[1])),
  );

  handle(
    worktreeChannels.view,
    devUrl,
    async (args): Promise<FileView> =>
      viewFile(await top(slugOf(args[0]), folderOf(args[2])), pathOf(args[1])),
  );

  // A file the chat names, as the Files screen can open it.
  handle(
    worktreeChannels.locate,
    devUrl,
    async (args): Promise<string | null> => {
      const slug = slugOf(args[0]);
      const path = pathOf(args[1]);
      const primary = await folderAt(slug, 0);
      const found = await locate(primary);
      if (found.kind !== "ready" || !primary) return null;
      // A bare name is looked up in `ls-files`: an automatic read.
      await assertReadable(found.top);
      return locateInRepo(found.top, primary, path);
    },
  );

  // "Open in Default App" from the Files tree's menu.
  //
  // NOTE: Opening an app, a script or an executable RUNS it, and a repository
  // is full of files an agent wrote (FE-77, D8 / SX-04).
  //
  // - The path is resolved all the way through: a link is judged by what it
  //   points at, and one that leaves the repository is refused.
  // - A directory is refused: an `.app` or a `.workflow` is one, and so is
  //   any folder macOS treats as a bundle.
  // - Anything `LAUNCHABLE` names, or with an execute bit, is refused.
  // - Only a document or media type ({@link opensInDefaultApp}) goes to the
  //   default app. Anything else (`.fileloc`, `.vbs`, a name with no
  //   extension) is revealed in Finder instead, where the user decides.
  handle(worktreeChannels.openDefault, devUrl, async (args): Promise<void> => {
    const path = pathOf(args[1]);
    const full = await locateFile(
      await top(slugOf(args[0]), folderOf(args[2])),
      path,
    );
    if (!full) throw new Error("That file is not there any more.");
    const info = await stat(full);
    if (!info.isFile())
      throw new Error("Lanework opens files only. Use Reveal in Finder.");
    if (LAUNCHABLE.test(full) || (info.mode & 0o111) !== 0)
      throw new Error("Lanework does not open files that would run.");
    if (!opensInDefaultApp(full)) {
      shell.showItemInFolder(full);
      return;
    }
    const failed = await shell.openPath(full);
    if (failed) throw new Error(failed);
  });

  // NOTE: Finder, never `shell.openPath`. Opening a file in its default app
  // runs a `.command` or an `.app`, and reading a repository must not
  // execute it.
  handle(worktreeChannels.reveal, devUrl, async (args): Promise<void> => {
    const full = await locateFile(
      await top(slugOf(args[0]), folderOf(args[2])),
      pathOf(args[1]),
    );
    if (!full) throw new Error("That file is not there any more.");
    shell.showItemInFolder(full);
  });

  handle(
    worktreeChannels.status,
    devUrl,
    async (args): Promise<WorktreeState> =>
      current(slugOf(args[0]), folderOf(args[1])),
  );

  handle(
    worktreeChannels.patch,
    devUrl,
    async (args): Promise<WorktreePatch> =>
      patch(await readable(slugOf(args[0]))),
  );

  handle(
    worktreeChannels.fileText,
    devUrl,
    async (args): Promise<string | null> => {
      if (typeof args[1] !== "string" || args[1].length > 4_096)
        throw new Error("That is not a file in this repository.");
      return fileText(
        await readable(slugOf(args[0])),
        args[1],
        sideOf(args[2]),
      );
    },
  );

  // Every write answers the NEW status. The screen redraws from what git says
  // afterwards rather than from what it hoped the call did.
  handle(
    worktreeChannels.stage,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      await stage(await top(slug), pathsOf(args[1]));
      return current(slug);
    },
  );

  handle(
    worktreeChannels.unstage,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      await unstage(await top(slug), pathsOf(args[1]));
      return current(slug);
    },
  );

  handle(
    worktreeChannels.restore,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      await restore(await top(slug), pathsOf(args[1]));
      return current(slug);
    },
  );

  handle(
    worktreeChannels.commit,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      const message = typeof args[1] === "string" ? args[1].trim() : "";
      if (!message) throw new Error("Write a commit message first.");
      if (message.length > 20_000) throw new Error("That message is too long.");
      const mode = args[2] as CommitMode;
      if (mode !== "staged" && mode !== "tracked")
        throw new Error("That is not a way to commit.");
      await commit(await top(slug), message, mode);
      return current(slug);
    },
  );

  handle(
    worktreeChannels.sync,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      const action = args[1] as SyncAction;
      if (!SYNC_ACTIONS.includes(action))
        throw new Error("That is not a way to sync.");
      const remote = args[2];
      if (
        remote !== null &&
        (typeof remote !== "string" || !remote || remote.length > 255)
      )
        throw new Error("Choose a remote.");
      await sync(await top(slug), action, remote);
      return current(slug);
    },
  );

  // FE-102: the gate's answer, seen and changed from the app.
  handle(
    worktreeChannels.repoTrust,
    devUrl,
    (args): Promise<RepoTrust> => repoTrust(slugOf(args[0]), folderOf(args[1])),
  );
  handle(
    worktreeChannels.askAgain,
    devUrl,
    async (args): Promise<RepoTrust> => {
      const slug = slugOf(args[0]);
      const folder = folderOf(args[1]);
      const found = await repo(slug, folder);
      if (!("state" in found)) await askAgain(found.top);
      return repoTrust(slug, folder);
    },
  );
  handle(
    worktreeChannels.restrict,
    devUrl,
    async (args): Promise<RepoTrust> => {
      const slug = slugOf(args[0]);
      const folder = folderOf(args[1]);
      const found = await repo(slug, folder);
      if (!("state" in found)) await restrictTrust(found.top);
      return repoTrust(slug, folder);
    },
  );

  handle(worktreeChannels.log, devUrl, async (args): Promise<CommitHistory> => {
    const skip = args[1];
    if (typeof skip !== "number" || !Number.isInteger(skip) || skip < 0)
      throw new Error("That is not a page of history.");
    return log(await readable(slugOf(args[0])), skip);
  });

  handle(worktreeChannels.show, devUrl, async (args): Promise<CommitChange> => {
    if (typeof args[1] !== "string") throw new Error("A commit is required.");
    return show(await readable(slugOf(args[0])), args[1]);
  });

  handle(
    worktreeChannels.branches,
    devUrl,
    async (args): Promise<BranchList | null> => {
      const found = await repo(slugOf(args[0]));
      if ("state" in found) return null;
      await assertReadable(found.top);
      return branches(found.top);
    },
  );

  handle(
    worktreeChannels.switchBranch,
    devUrl,
    async (args): Promise<WorktreeState> => {
      const slug = slugOf(args[0]);
      const name = args[1];
      if (typeof name !== "string" || !name || name.length > 255)
        throw new Error("Choose a branch.");
      await switchBranch(await top(slug), name);
      return current(slug);
    },
  );
}
