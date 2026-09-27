import {
  type BranchList,
  type CommitChange,
  type CommitHistory,
  type CommitMode,
  type FileSide,
  type SyncAction,
  type WorktreePatch,
  type WorktreeState,
  worktreeChannels,
} from "../../../shared/worktree";
import { handle } from "../ipc";
import { authorizedRecord } from "../workspaces";
import { readFolders } from "../workspaces/store";
import {
  branches,
  commit,
  fileText,
  locate,
  log,
  patch,
  restore,
  show,
  stage,
  status,
  switchBranch,
  sync,
  unstage,
} from "./worktree";

/**
 * The local-repository channels (FE-22).
 *
 * ⚠️ Every one of them takes a SLUG and resolves the folder here, from what this
 * machine wrote down — the same rule `repoState` follows for the remote. No
 * channel accepts a directory.
 */

function slugOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required.");
  return value;
}

const SYNC_ACTIONS: SyncAction[] = [
  "fetch",
  "pull",
  "pull-rebase",
  "push",
  "force-push",
];

/** At most this many paths in one call — a "Stage All" on a big refactor, not more. */
const MAX_PATHS = 5_000;

function pathsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS)
    throw new Error("Choose at least one file.");
  return value.map((path) => {
    if (typeof path !== "string" || !path || path.length > 4_096)
      throw new Error("That is not a file in this repository.");
    return path;
  });
}

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

/** The repository's top level, or the state that says why there is none. */
async function repo(
  slug: string,
): Promise<{ top: string } | { state: WorktreeState }> {
  const record = await authorizedRecord();
  const primary = (await readFolders(record))[slug]?.[0] ?? null;
  const found = await locate(primary);
  return found.kind === "ready" ? { top: found.top } : { state: found };
}

async function top(slug: string): Promise<string> {
  const found = await repo(slug);
  if ("state" in found)
    throw new Error("This project has no local repository to read.");
  return found.top;
}

async function current(slug: string): Promise<WorktreeState> {
  const found = await repo(slug);
  return "state" in found ? found.state : status(found.top);
}

export function registerWorktree(devUrl?: string): void {
  handle(
    worktreeChannels.status,
    devUrl,
    async (args): Promise<WorktreeState> => current(slugOf(args[0])),
  );

  handle(
    worktreeChannels.patch,
    devUrl,
    async (args): Promise<WorktreePatch> => patch(await top(slugOf(args[0]))),
  );

  handle(
    worktreeChannels.fileText,
    devUrl,
    async (args): Promise<string | null> => {
      if (typeof args[1] !== "string" || args[1].length > 4_096)
        throw new Error("That is not a file in this repository.");
      return fileText(await top(slugOf(args[0])), args[1], sideOf(args[2]));
    },
  );

  // ⚠️ Every write answers the NEW status. The screen redraws from what git says
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

  handle(worktreeChannels.log, devUrl, async (args): Promise<CommitHistory> => {
    const skip = args[1];
    if (typeof skip !== "number" || !Number.isInteger(skip) || skip < 0)
      throw new Error("That is not a page of history.");
    return log(await top(slugOf(args[0])), skip);
  });

  handle(worktreeChannels.show, devUrl, async (args): Promise<CommitChange> => {
    if (typeof args[1] !== "string") throw new Error("A commit is required.");
    return show(await top(slugOf(args[0])), args[1]);
  });

  handle(
    worktreeChannels.branches,
    devUrl,
    async (args): Promise<BranchList | null> => {
      const found = await repo(slugOf(args[0]));
      return "state" in found ? null : branches(found.top);
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
