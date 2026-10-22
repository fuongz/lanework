import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardView } from "../../../shared/workspaces";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";
import { appHomeDir } from "../paths";

/**
 * The file key for one Lanework account on one API origin.
 *
 * The origin is part of it, so identical ids on another control plane cannot
 * share state.
 *
 * NOTE: Anything else filed per Lanework account must reuse this function. A
 * second copy would drift, and one account would read another's rows.
 */
function accountKey(record: MachineRecord): string {
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
 * NOTE: Two shapes, and a `v2` file may carry either key.
 * - The cloud workspace id is preferred: every board call is addressed by it,
 *   and a rename cannot move it.
 * - A service that predates the id field gives the app only the slug, and
 *   "no id" must not mean "no selection".
 * - A `v1` file (a bare slug) is read for the same reason. Dropping it would
 *   move every existing user back to "no workspace selected" on upgrade.
 */
type ActiveSelection =
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
 * NOTE: Both keys are written, because only one of them may exist. The board
 * needs the id. An older service can only be matched on the slug; without it
 * the app asks "choose a workspace" every time it opens against one.
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
  // The workspace id is hashed too: it comes from the service, and a value
  // with a slash in it must not be able to choose a path.
  const key = createHash("sha256")
    .update(`${accountKey(record)}:${workspaceId}`)
    .digest("hex");
  return join(appHomeDir(), "workspaces", `board-${key}.json`);
}

/**
 * The last board read that succeeded, per account and per workspace.
 *
 * Derived and deletable. It exists only so a failed read can show the last
 * good copy, labelled, instead of an empty board. "Nothing here" and "I could
 * not ask" look the same on screen, and the first invites someone to retype a
 * card that already exists.
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
    // NOTE: Fields added to `BoardView` after a cache was written are absent
    // from it, and the read above is a cast, not a parse. `labels` would come
    // back `undefined` and the first `.map` on it would take the offline board
    // down. They are filled in here rather than by bumping `v`, which would
    // drop every cache and leave a user with no board on the one launch they
    // have no network for.
    //
    // NOTE: The card fields are filled with `null`, not `[]` or `false`. A
    // cached board is a list read, where those five mean "not asked", and
    // `false` would draw "Subscribe" on a card the reader follows.
    return {
      ...data.view,
      labels: data.view.labels ?? [],
      members: data.view.members ?? [],
      cards: (data.view.cards ?? []).map((card) => ({
        ...card,
        subscribers: card.subscribers ?? null,
        subscribed: card.subscribed ?? null,
        favorite: card.favorite ?? null,
        commentCount: card.commentCount ?? null,
        attachments: card.attachments ?? null,
      })),
      // Whatever it said when written, reading it back is serving a copy.
      stale: true,
    };
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
    // A board that cannot be cached still works. Failing the read over it
    // would trade a real answer for a housekeeping error.
  });
}

function foldersFile(record: MachineRecord): string {
  return join(appHomeDir(), "workspaces", `folders-${accountKey(record)}.json`);
}

/**
 * Which folders on this machine each workspace is made of, by slug.
 *
 * - A list, primary first. A project is created against the folders picked in
 *   one chooser (several, for a repo split across checkouts). `paths[0]` is
 *   the one every single-folder surface means: the migration reader, "open in
 *   file manager", the rail's label. Order carries that, so a primary that is
 *   not in the list cannot be stored.
 * - A `v1` file holds one path per slug and is read as a list of one.
 *   Dropping it would unlink every folder existing users have chosen.
 * - By slug, unlike {@link readActive}. A service that predates the workspace
 *   id sends none, and that is the case this link matters most for: the
 *   screen that says the board cannot be opened. The slug is safe to key on:
 *   no route on the service can change one.
 *
 * NOTE: Per account and per API origin, like everything in this file. Two
 * accounts on one machine may have projects with the same slug in different
 * folders, and one reading the other's path is a leak.
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
 * Link folders to a workspace, primary first, or unlink it with `null`.
 *
 * A replace, not an append. Every caller states the whole set: the create
 * dialog knows what was picked, and "Change folder" means one folder now. An
 * append would make "I chose the wrong one" unfixable from either. Duplicates
 * are dropped.
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
 * - Written even when the run failed, and especially then. "Which cards
 *   landed before the network went?" is the one question a resumed migration
 *   needs answered. The API's idempotency only helps a client that knows what
 *   to send again.
 * - Under the app home, never in the repo. A migration is a fact about this
 *   machine's copy, and a receipt in `.agents/` would land in everybody's git
 *   history. The import promises to leave the source folder as it was.
 */
interface MigrationRun {
  workspaceId: string;
  /** When the run finished, as an ISO timestamp. */
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
