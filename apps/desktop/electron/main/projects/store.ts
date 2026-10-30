import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { BoardView } from "../../../shared/projects";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";
import { projectsDir } from "../paths";

/**
 * The file key for one Lanework account on one API origin.
 *
 * The origin is part of it, so identical ids on another control plane cannot
 * share state.
 *
 * NOTE: Anything else filed per Lanework account must reuse this function. A
 * second copy would drift, and one account would read another's rows.
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

// ── Layout (FE-108) ───────────────────────────────────────────────────────
//
// <home>/projects/
//   local/                 local mode's account (`LOCAL_API`)
//   <accountKey>/          one cloud account on one API origin
//     active.json          the open project
//     projects.json        id → slug, as the last list read said
//     <slug>/              one folder per project
//       folders.json       its folders on this machine, primary first
//       board.json         the last board read that succeeded
//       migration.json     the last local → cloud import run
//     .pending/<sha(id)>/  board / migration files whose slug is not known yet
//
// A project folder is named by its slug: the one key every caller has (a
// service that predates the id sends none), never renamed (the service
// refuses a slug change), and readable. The account level keeps two accounts
// with the same slug apart.

/** The API origin `LOCAL_RECORD` carries (`session.ts`): local mode. */
export const LOCAL_API = "lanework-local:";

/** The service's slug pattern (`slug.ts`); anything else never becomes a path. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSlug(value: string): boolean {
  return value.length <= 64 && SLUG.test(value);
}

/** The account's folder: `local`, or the {@link accountKey} of a cloud one. */
export function accountDir(record: MachineRecord): string {
  return join(
    projectsDir(),
    record.apiUrl === LOCAL_API ? "local" : accountKey(record),
  );
}

function projectDir(record: MachineRecord, slug: string): string {
  if (!isSlug(slug)) throw new Error("That project key is not valid.");
  return join(accountDir(record), slug);
}

/**
 * Where a project's files wait until its slug is known.
 *
 * The id is hashed: it comes from the service, and a value with a slash in it
 * must not be able to choose a path.
 */
export function pendingDir(record: MachineRecord, projectId: string): string {
  return join(
    accountDir(record),
    ".pending",
    createHash("sha256").update(projectId).digest("hex"),
  );
}

/** Each account's id → slug index, as last read or written this run. */
const slugIndex = new Map<string, Record<string, string>>();

const indexFile = (record: MachineRecord) =>
  join(accountDir(record), "projects.json");

async function readIndex(
  record: MachineRecord,
): Promise<Record<string, string>> {
  const key = accountDir(record);
  const known = slugIndex.get(key);
  if (known) return known;
  let slugs: Record<string, string> = {};
  try {
    const data = JSON.parse(await readFile(indexFile(record), "utf8")) as {
      v?: unknown;
      slugs?: unknown;
    };
    if (data?.v === 1 && data.slugs && typeof data.slugs === "object")
      slugs = Object.fromEntries(
        Object.entries(data.slugs as Record<string, unknown>).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && isSlug(entry[1]),
        ),
      );
  } catch {
    // No index yet: every project reads from `.pending` until a list arrives.
  }
  slugIndex.set(key, slugs);
  return slugs;
}

/**
 * Record the account's projects as a list read just returned them, and move
 * each one's waiting files into its folder.
 *
 * NOTE: `projects` must be the account's WHOLE list. What is still pending
 * afterwards belongs to no project the account has, and is deleted (FE-108/D3):
 * a board cache and an import run for a project that is gone are both stale.
 */
export async function indexProjects(
  record: MachineRecord,
  projects: readonly { id: string | null; slug: string }[],
): Promise<void> {
  const slugs: Record<string, string> = {};
  for (const project of projects)
    if (project.id && isSlug(project.slug)) slugs[project.id] = project.slug;
  const before = await readIndex(record);
  slugIndex.set(accountDir(record), slugs);
  if (JSON.stringify(before) !== JSON.stringify(slugs))
    await writeAtomic(indexFile(record), JSON.stringify({ v: 1, slugs })).catch(
      () => {},
    );
  for (const [id, slug] of Object.entries(slugs)) {
    const waiting = pendingDir(record, id);
    for (const name of await readdir(waiting).catch(() => [] as string[])) {
      const target = join(projectDir(record, slug), name);
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      // A file already in the folder is newer than the one that waited.
      await readFile(target)
        .then(() => rm(join(waiting, name), { force: true }))
        .catch(() => rename(join(waiting, name), target))
        .catch(() => {});
    }
  }
  await rm(join(accountDir(record), ".pending"), {
    recursive: true,
    force: true,
  }).catch(() => {});
}

/** A per-project file: in the project's folder, or waiting for its slug. */
async function projectFile(
  record: MachineRecord,
  projectId: string,
  name: string,
): Promise<string> {
  const slug = (await readIndex(record))[projectId];
  return slug
    ? join(projectDir(record, slug), name)
    : join(pendingDir(record, projectId), name);
}

function activeFile(record: MachineRecord): string {
  return join(accountDir(record), "active.json");
}

/**
 * What the last selection named.
 *
 * NOTE: Two shapes, and a `v2` file may carry either key.
 * - The cloud project id is preferred: every board call is addressed by it,
 *   and a rename cannot move it.
 * - A service that predates the id field gives the app only the slug, and
 *   "no id" must not mean "no selection".
 * - A `v1` file (a bare slug) is read for the same reason. Dropping it would
 *   move every existing user back to "no project selected" on upgrade.
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
    throw new Error("Could not read your project selection. Try again.");
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
 * the app asks "choose a project" every time it opens against one.
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

/**
 * A {@link BoardView} as `<slug>/board.json` holds it.
 *
 * NOTE: The file keeps `workspaceId`, the field's name before projects were
 * called projects (FE-107). Renaming it on disk would make every cache a miss
 * once, on the one launch that may have no network to refill it.
 */
type DiskBoardView = Omit<BoardView, "projectId"> & { workspaceId: string };

const boardFile = (record: MachineRecord, projectId: string) =>
  projectFile(record, projectId, "board.json");

/**
 * The last board read that succeeded, per account and per project.
 *
 * Derived and deletable. It exists only so a failed read can show the last
 * good copy, labelled, instead of an empty board. "Nothing here" and "I could
 * not ask" look the same on screen, and the first invites someone to retype a
 * card that already exists.
 */
export async function readBoardCache(
  record: MachineRecord,
  projectId: string,
): Promise<BoardView | null> {
  try {
    const data = JSON.parse(
      await readFile(await boardFile(record, projectId), "utf8"),
    ) as { v?: unknown; view?: DiskBoardView };
    if (!data?.view) return null;
    const { workspaceId, ...rest } = data.view;
    if (data.v !== 1 || workspaceId !== projectId) return null;
    const view: BoardView = { ...rest, projectId: workspaceId };
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
      ...view,
      labels: view.labels ?? [],
      members: view.members ?? [],
      cards: (view.cards ?? []).map((card) => ({
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
  projectId: string,
  view: BoardView,
): Promise<void> {
  const { projectId: workspaceId, ...rest } = view;
  const disk: DiskBoardView = { ...rest, workspaceId };
  await writeAtomic(
    await boardFile(record, projectId),
    JSON.stringify({ v: 1, view: disk }),
  ).catch(() => {
    // A board that cannot be cached still works. Failing the read over it
    // would trade a real answer for a housekeeping error.
  });
}

const foldersFile = (record: MachineRecord, slug: string) =>
  join(projectDir(record, slug), "folders.json");

/** One project's `folders.json`: `{ v: 1, paths }`, primary first. */
function parsePaths(data: unknown): string[] {
  const paths = (data as { v?: unknown; paths?: unknown } | null)?.paths;
  if ((data as { v?: unknown } | null)?.v !== 1 || !Array.isArray(paths))
    return [];
  return paths.filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
}

/**
 * Which folders on this machine each project is made of, by slug.
 *
 * - A list, primary first. A project is created against the folders picked in
 *   one chooser (several, for a repo split across checkouts). `paths[0]` is
 *   the one every single-folder surface means: the migration reader, "open in
 *   file manager", the rail's label. Order carries that, so a primary that is
 *   not in the list cannot be stored.
 * - Read from each project folder's `folders.json` (FE-108). The flat
 *   `folders-<key>.json` of older builds is split into those at startup
 *   (`layout-migration.ts`), so no existing link is dropped.
 * - By slug, unlike {@link readActive}. A service that predates the project
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
  const out: Record<string, string[]> = {};
  let entries: string[];
  try {
    entries = await readdir(accountDir(record));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw new Error("Could not read your linked folders. Try again.");
  }
  for (const slug of entries) {
    if (!isSlug(slug)) continue;
    try {
      const paths = parsePaths(
        JSON.parse(await readFile(foldersFile(record, slug), "utf8")),
      );
      if (paths.length) out[slug] = paths;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw new Error("Could not read your linked folders. Try again.");
    }
  }
  return out;
}

/**
 * Link folders to a project, primary first, or unlink it with `null`.
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
  const unique = paths ? [...new Set(paths.filter(Boolean))] : [];
  const file = foldersFile(record, slug);
  if (unique.length)
    await writeAtomic(file, JSON.stringify({ v: 1, paths: unique }));
  else {
    await rm(file, { force: true }).catch(() => {});
    // An unlinked project with no cache leaves no empty folder behind.
    await rmdir(projectDir(record, slug)).catch(() => {});
  }
  return readFolders(record);
}

const runFile = (record: MachineRecord, projectId: string) =>
  projectFile(record, projectId, "migration.json");

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
  projectId: string;
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

/**
 * A {@link MigrationRun} as `<slug>/migration.json` holds it.
 *
 * NOTE: `workspaceId` on disk, as before FE-107: a receipt is what a resumed
 * migration reads to know which cards already landed, so it must survive the
 * rename.
 */
type DiskMigrationRun = Omit<MigrationRun, "projectId"> & {
  workspaceId: string;
};

export async function readMigrationRun(
  record: MachineRecord,
  projectId: string,
): Promise<MigrationRun | null> {
  try {
    const data = JSON.parse(
      await readFile(await runFile(record, projectId), "utf8"),
    ) as { v?: unknown; run?: DiskMigrationRun };
    if (!data?.run) return null;
    const { workspaceId, ...rest } = data.run;
    if (data.v !== 1 || workspaceId !== projectId) return null;
    return { ...rest, projectId: workspaceId };
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
  const { projectId, ...rest } = stored;
  const disk: DiskMigrationRun = { ...rest, workspaceId: projectId };
  await writeAtomic(
    await runFile(record, projectId),
    JSON.stringify({ v: 1, run: disk }),
  );
  return stored;
}
