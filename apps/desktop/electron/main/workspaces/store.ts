import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardView } from "../../../shared/workspaces";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";
import { appHomeDir } from "../paths";

/**
 * Include the origin so identical IDs on another control plane cannot share state.
 *
 * ⚠️ Exported so state OUTSIDE this folder is filed under the same key — the
 * GitHub connection in `../git/store.ts` is per Lanework account for the same
 * reason a folder link is. A second copy of this function would eventually
 * disagree, and then one account would be reading another's rows.
 */
export function accountKey(record: MachineRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        resolveApi(record.apiUrl),
        record.userId,
        record.machineId,
      ]),
    )
    .digest("hex");
}

function activeFile(record: MachineRecord): string {
  return join(appHomeDir(), "workspaces", `${accountKey(record)}.json`);
}

/**
 * What the last selection named.
 *
 * ⚠️ Two shapes, and a `v2` file may carry EITHER key. The cloud workspace id is
 * preferred — it is what every board call is addressed by, and a rename cannot
 * move it — but a service that predates the id field gives the app nothing else
 * to remember, and "no id" must not mean "no selection". A `v1` file (a bare
 * slug) is honoured for the same reason: dropping it would silently move every
 * existing user back to "no workspace selected" on upgrade.
 */
export type ActiveSelection =
  | { by: "id"; value: string }
  | { by: "slug"; value: string }
  | null;

export async function readActive(
  record: MachineRecord,
): Promise<ActiveSelection> {
  try {
    const data = JSON.parse(await readFile(activeFile(record), "utf8")) as {
      v?: unknown;
      active?: unknown;
      activeId?: unknown;
      activeSlug?: unknown;
    };
    if (data?.v === 2) {
      if (typeof data.activeId === "string")
        return { by: "id", value: data.activeId };
      if (typeof data.activeSlug === "string")
        return { by: "slug", value: data.activeSlug };
      return null;
    }
    if (data?.v === 1 && typeof data.active === "string")
      return { by: "slug", value: data.active };
    return null;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw new Error("Could not read your workspace selection. Try again.");
  }
}

/** Write a file with no torn reads, and never leave the temporary behind. */
export async function writeAtomic(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    throw new Error("Could not save that on this machine. Try again.");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Remember a selection.
 *
 * ⚠️ Both keys are written, because only one of them may exist. The id is what
 * the board needs; the slug is what an older service can still be matched on,
 * and keeping it is the difference between "your project is remembered" and
 * "choose a workspace" every time the app opens against such a service.
 */
export async function writeActive(
  record: MachineRecord,
  selection: { id: string | null; slug: string | null },
): Promise<void> {
  await writeAtomic(
    activeFile(record),
    JSON.stringify({
      v: 2,
      activeId: selection.id,
      activeSlug: selection.slug,
    }),
  );
}

function boardFile(record: MachineRecord, workspaceId: string): string {
  // The workspace id is hashed too: it comes from the service, and a value with
  // a slash in it must not be able to choose a path.
  const key = createHash("sha256")
    .update(`${accountKey(record)}:${workspaceId}`)
    .digest("hex");
  return join(appHomeDir(), "workspaces", `board-${key}.json`);
}

/**
 * The last board read that succeeded.
 *
 * ⚠️ Derived, deletable, per account and per workspace — and the ONLY reason it
 * exists is so a failed read can show the last good copy WITH a label instead of
 * an empty board. "Nothing here" and "I could not ask" look identical on screen,
 * and the first one invites somebody to start typing a card that already exists.
 */
export async function readBoardCache(
  record: MachineRecord,
  workspaceId: string,
): Promise<BoardView | null> {
  try {
    const data = JSON.parse(
      await readFile(boardFile(record, workspaceId), "utf8"),
    ) as { v?: unknown; view?: BoardView };
    if (data?.v !== 1 || !data.view || data.view.workspaceId !== workspaceId)
      return null;
    // Whatever it said when it was written, reading it back is by definition
    // serving a copy.
    return { ...data.view, stale: true };
  } catch {
    // A missing or corrupt cache is not an error: the caller's own failure is
    // the one worth reporting.
    return null;
  }
}

export async function writeBoardCache(
  record: MachineRecord,
  workspaceId: string,
  view: BoardView,
): Promise<void> {
  await writeAtomic(
    boardFile(record, workspaceId),
    JSON.stringify({ v: 1, view }),
  ).catch(() => {
    // A board that cannot be cached still works; failing the read over it would
    // trade a real answer for a housekeeping error.
  });
}

function foldersFile(record: MachineRecord): string {
  return join(appHomeDir(), "workspaces", `folders-${accountKey(record)}.json`);
}

/**
 * Which folders on this machine a workspace is assembled from, by SLUG.
 *
 * ⚠️ A LIST, primary first. A project is created against the folders a person
 * picked in one chooser — several of them, for a repo split across checkouts —
 * and `paths[0]` is the one every single-folder surface means: the migration
 * reader, "open in file manager", the rail's label. Order carries that fact
 * rather than a second field, so there is no way to store a primary that is not
 * in the list.
 *
 * ⚠️ A `v1` file holds ONE path per slug and is read as a list of one. Dropping
 * it would silently unlink every folder every existing user has chosen.
 *
 * ⚠️ By slug, and that is not the same choice `readActive` makes. The cloud
 * workspace id is absent exactly when this feature matters most — a service
 * that predates the field sends none, which is the screen that tells the user
 * their board cannot be opened — so an id-keyed link would be unavailable in
 * its own main case. And the slug is safe to key on: no route on the service
 * can change one, so a rename cannot strand a link written here.
 *
 * ⚠️ Per account and per API origin, like everything else in this file: two
 * accounts on one machine may have projects with the same slug in different
 * folders, and one of them reading the other's path is a leak with a plausible
 * excuse.
 */
export async function readFolders(
  record: MachineRecord,
): Promise<Record<string, string[]>> {
  try {
    const data = JSON.parse(await readFile(foldersFile(record), "utf8")) as {
      v?: unknown;
      folders?: unknown;
    };
    if (
      (data?.v !== 1 && data?.v !== 2) ||
      !data.folders ||
      typeof data.folders !== "object"
    )
      return {};
    const out: Record<string, string[]> = {};
    for (const [slug, entry] of Object.entries(
      data.folders as Record<string, unknown>,
    )) {
      // `v1`: one path per slug. `v2`: the list, primary first.
      const paths = (Array.isArray(entry) ? entry : [entry]).filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
      if (paths.length) out[slug] = paths;
    }
    return out;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return {};
    throw new Error("Could not read your linked folders. Try again.");
  }
}

/**
 * Link folders to a workspace — primary first — or unlink it with `null`.
 *
 * ⚠️ A REPLACE, not an append. Every caller states the whole set it means: the
 * create dialog knows what was picked, "Change folder" means one folder now,
 * and an append would make "I chose the wrong one" unfixable from either.
 * Duplicates are dropped, because the same folder twice is one folder.
 */
export async function writeFolders(
  record: MachineRecord,
  slug: string,
  paths: string[] | null,
): Promise<Record<string, string[]>> {
  const folders = await readFolders(record);
  const unique = paths ? [...new Set(paths.filter(Boolean))] : [];
  if (!unique.length) delete folders[slug];
  else folders[slug] = unique;
  await writeAtomic(foldersFile(record), JSON.stringify({ v: 2, folders }));
  return folders;
}

function runFile(record: MachineRecord, workspaceId: string): string {
  const key = createHash("sha256")
    .update(`${accountKey(record)}:${workspaceId}:migration`)
    .digest("hex");
  return join(appHomeDir(), "workspaces", `migration-${key}.json`);
}

/**
 * What the last import run did, per record.
 *
 * ⚠️ Written even when the run failed — especially then. "Which cards landed
 * before the network went?" is the one question a resumed migration needs
 * answered, and the API's idempotency only helps a client that knows what to
 * send again.
 *
 * ⚠️ Under the app home, never in the repo. A migration is a fact about THIS
 * machine's copy of the data, and writing it into `.agents/` would put a
 * machine-local receipt into everybody's git history — while the whole promise
 * of the import is that the source folder is left exactly as it was.
 */
export interface MigrationRun {
  workspaceId: string;
  /** ISO, when the run finished. */
  at: string;
  summary: Record<string, number>;
  receipts: {
    ref: string;
    status: string;
    taskId?: string | null;
    error?: string;
  }[];
  /** sha256 over the receipts, so the seal can name the run it is sealing. */
  digest: string;
  migratedAt: string | null;
}

export async function readMigrationRun(
  record: MachineRecord,
  workspaceId: string,
): Promise<MigrationRun | null> {
  try {
    const data = JSON.parse(
      await readFile(runFile(record, workspaceId), "utf8"),
    ) as { v?: unknown; run?: MigrationRun };
    if (data?.v !== 1 || !data.run || data.run.workspaceId !== workspaceId)
      return null;
    return data.run;
  } catch {
    // A missing or truncated receipt must not break the next run; what it
    // described is still discoverable from the board's own audit.
    return null;
  }
}

export async function writeMigrationRun(
  record: MachineRecord,
  run: Omit<MigrationRun, "digest"> & { digest?: string },
): Promise<MigrationRun> {
  const stored: MigrationRun = {
    ...run,
    digest:
      run.digest ??
      createHash("sha256").update(JSON.stringify(run.receipts)).digest("hex"),
  };
  await writeAtomic(
    runFile(record, run.workspaceId),
    JSON.stringify({ v: 1, run: stored }),
  );
  return stored;
}
