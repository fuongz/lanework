// The git origins of the folders a new project is built from (FE-121).
//
// Read before the project exists, so the create dialog can offer "Local" or
// one row per distinct repo. Only reads: `rev-parse` and `remote get-url`,
// through the safe runner. Nothing is initialised, added or cloned.
//
// NOTE: A failed read is reported as a failure, never as "no repo"
// (FE-121/D7). "Git is not installed" and "this folder has no origin" call
// for different things from the user, and only the second one means Local.
import { basename } from "node:path";
import type {
  FolderOrigin,
  OriginScan,
  RepoChoice,
} from "../../../shared/projects";
import { normalizeRepo } from "../../local-store/ids";
import type { MachineRecord } from "../auth/store";
import { GitMissingError, gitRead } from "../git/runner";
import { fetchBoardsForRepo } from "./client";
import { folderExists } from "./local-folder";

/** A git call's budget: a slow network share should not hold the dialog. */
const GIT_TIMEOUT = 5_000;

/** One folder's origin, as it is, plus the remote AS IS for the service. */
export interface ReadOrigin {
  origin: FolderOrigin;
  /** The remote exactly as git printed it, when there is one. */
  remote: string | null;
}

/** git's "this is not a repository" answer, in any of its wordings. */
const NOT_A_REPO = /not a git repository/i;

/** Read one folder's repo root and origin. */
export async function readOrigin(
  id: string,
  path: string,
): Promise<ReadOrigin> {
  const base: FolderOrigin = { id, path, name: basename(path), status: "none" };
  if (!(await folderExists(path)))
    return {
      origin: {
        ...base,
        status: "error",
        error: "This folder is no longer there.",
      },
      remote: null,
    };
  let root: string;
  try {
    root = (
      await gitRead(path, ["rev-parse", "--show-toplevel"], {
        timeout: GIT_TIMEOUT,
        maxBuffer: 16_384,
      })
    ).stdout.trim();
  } catch (failure) {
    if (failure instanceof GitMissingError)
      return {
        origin: {
          ...base,
          status: "error",
          error: "Git is not installed, so its repo could not be read.",
        },
        remote: null,
      };
    const said = failure instanceof Error ? failure.message : String(failure);
    if (NOT_A_REPO.test(said)) return { origin: base, remote: null };
    return {
      origin: {
        ...base,
        status: "error",
        error: /EACCES|EPERM|permission denied/i.test(said)
          ? "This app has no permission to read this folder."
          : /ETIMEDOUT|timed out|SIGTERM/i.test(said)
            ? "Reading its repo took too long."
            : said || "Git could not read it.",
      },
      remote: null,
    };
  }
  // `remote get-url` exits 2 when there is no such remote: an answer, "none".
  let remote: string;
  try {
    const read = await gitRead(path, ["remote", "get-url", "origin"], {
      ok: [2],
      timeout: GIT_TIMEOUT,
      maxBuffer: 16_384,
    });
    remote = read.code === 0 ? read.stdout.trim() : "";
  } catch (failure) {
    return {
      origin: {
        ...base,
        status: "error",
        error:
          failure instanceof Error && failure.message
            ? failure.message
            : "Git could not read its origin.",
      },
      remote: null,
    };
  }
  const withRoot = root && root !== path ? { ...base, root } : base;
  if (!remote) return { origin: withRoot, remote: null };
  const repo = normalizeRepo(remote);
  if (!repo)
    return { origin: { ...withRoot, status: "unsupported" }, remote: null };
  return { origin: { ...withRoot, status: "repo", repo }, remote };
}

/**
 * Every picked folder's origin, and the distinct repos among them.
 *
 * @param record The signed-in account, or null: signed out, the repos are
 *   listed but their boards are not looked up.
 */
export async function scanOrigins(
  folders: { id: string; path: string }[],
  record: MachineRecord | null,
): Promise<OriginScan> {
  const read = await Promise.all(
    folders.map((folder) => readOrigin(folder.id, folder.path)),
  );
  const groups = new Map<string, { remote: string; folderIds: string[] }>();
  for (const { origin, remote } of read) {
    if (origin.status !== "repo" || !origin.repo || !remote) continue;
    const group = groups.get(origin.repo);
    if (group) group.folderIds.push(origin.id);
    else groups.set(origin.repo, { remote, folderIds: [origin.id] });
  }
  const repos: RepoChoice[] = await Promise.all(
    [...groups].map(async ([repo, group]) => ({
      repo,
      folderIds: group.folderIds,
      boards: record
        ? await fetchBoardsForRepo(record, group.remote).then(
            (boards) =>
              boards.map((board) => ({
                id: board.workspaceId,
                name: board.name,
              })),
            () => null,
          )
        : null,
    })),
  );
  return {
    folders: read.map((entry) => entry.origin),
    repos,
    canLink: record !== null,
  };
}

/**
 * The remote of `repo` among `folders`, read again here in main.
 *
 * The create call names a repo by its key; the URL the service receives is
 * the one git prints for the first picked clone of it, never one the
 * renderer sent.
 */
export async function remoteFor(
  folders: { id: string; path: string }[],
  repo: string,
): Promise<{ remote: string; folderIds: string[] } | null> {
  const read = await Promise.all(
    folders.map((folder) => readOrigin(folder.id, folder.path)),
  );
  const clones = read.filter(
    (entry) => entry.origin.repo === repo && entry.remote,
  );
  const [first] = clones;
  if (!first?.remote) return null;
  return {
    remote: first.remote,
    folderIds: clones.map((entry) => entry.origin.id),
  };
}
