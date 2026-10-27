import { BrowserWindow } from "electron";
import { can } from "../../../shared/policy";
import {
  type BoardActivityPage,
  type BoardAttachment,
  type BoardAttachmentDraft,
  type BoardCard,
  type BoardCardDraft,
  type BoardCardPatch,
  type BoardChanges,
  type BoardChecklistDraft,
  type BoardPlacement,
  type BoardQuery,
  type BoardStats,
  type BoardView,
  type BoardWrite,
  boardQueryKey,
  CHECKLIST_LIMITS,
  CHECKLIST_SECTIONS,
  DEFAULT_BOARD_QUERY,
  type ImportPreview,
  type ImportReport,
  type LocalFolderState,
  type LocalSyncResult,
  type PickedFolder,
  type Workspace,
  type WorkspaceSnapshot,
  workspaceChannels,
} from "../../../shared/workspaces";
import { currentSession } from "../auth";
import { resolveApi } from "../auth/client";
import { readLocalMode } from "../auth/local-mode";
import { type MachineRecord, readRecord } from "../auth/store";
import { broadcast, handle } from "../ipc";
import {
  archiveCard,
  attachFile,
  createCard,
  createComment,
  createWorkspace,
  deleteComment,
  deleteWorkspace,
  detachFile,
  editComment,
  fetchActivity,
  fetchBoardConfig,
  fetchCard,
  fetchCards,
  fetchChanges,
  fetchCheckpoint,
  fetchGroup,
  fetchPresence,
  fetchStats,
  fetchWorkspaces,
  type GroupSpec,
  groupSpecs,
  importRecords,
  lookupCard,
  moveCard,
  purgeIssues,
  putBoardConfig,
  renameWorkspace,
  reorderWorkspaces,
  replaceChecklist,
  sealBoardMigration,
  searchCards,
  setFavorite,
  setSubscription,
  toggleChecklistItem,
  updateCard,
} from "./client";
import {
  chooseFolders,
  folderFor,
  pickFolder,
  registerFolder,
  revealFolder,
} from "./folder-chooser";
import { workspaceIcon } from "./icon";
import {
  cloudOnly,
  findLocalWorkspace,
  type LocalBoard,
  listLocalWorkspaces,
  localBoard,
  localStore,
  toWorkspace as localToWorkspace,
  watchLocalStore,
  writeLocal,
} from "./local-backend";
import { folderExists, readLocalFolder } from "./local-folder";
import { IMPORT_BATCH, planMigration } from "./review-import";
import { slugify } from "./slug";
import {
  readActive,
  readBoardCache,
  readFolders,
  readMigrationRun,
  writeActive,
  writeBoardCache,
  writeFolders,
  writeMigrationRun,
} from "./store";
import { syncLocalWorkspace } from "./sync-to-cloud";

/**
 * The credential this window is allowed to act with, or a refusal.
 *
 * NOTE: Exported for `../git`, which needs the same gate: its handlers file
 * state per Lanework account, so they have to agree with this file on which
 * account is asking. A second copy of this check is a second place for the
 * answer to drift.
 *
 * @throws When the window is signed out, or the session changed under it.
 */
export async function authorizedRecord(): Promise<MachineRecord> {
  const session = await currentSession();
  // FE-78/D7: the policy's own answer, so main enforces the rule the renderer
  // reads. The `kind` test only narrows the type for the reads below; with
  // `cloud:use` true for a `machine` alone, it never refuses on its own.
  if (
    !can(session.principal, "cloud:use") ||
    session.principal.kind !== "machine"
  )
    throw new Error("Sign in to load your workspaces.");
  const record = await readRecord();
  if (
    !record ||
    record.machineId !== session.principal.machineId ||
    record.userId !== session.principal.userId ||
    resolveApi(record.apiUrl) !== session.apiUrl
  )
    throw new Error("Your session changed. Try again.");
  return record;
}

async function assertSameSession(record: MachineRecord): Promise<void> {
  const current = await authorizedRecord();
  if (
    current.secret !== record.secret ||
    current.machineId !== record.machineId ||
    current.userId !== record.userId ||
    current.apiUrl !== record.apiUrl
  )
    throw new Error("Your session changed. Try again.");
}

// ── Local boards ────────────────────────────────────────────────────────────

/**
 * The "account" local boards file their per-account state under — the saved
 * selection and the folder links — through the same `store.ts` functions the
 * cloud account uses.
 *
 * NOTE: NOT a credential, and built so it can never act as one: no secret,
 * and an origin (`lanework-local:`) that no `fetch` can reach. A request made
 * with it by mistake fails on the spot instead of reaching the control plane,
 * which keeps "local mode sends nothing" (FE-52/V2) true even through code
 * written for the cloud. The same record is used signed in and not, so a
 * local board's folder link survives signing in and out.
 */
const LOCAL_RECORD: MachineRecord = {
  machineId: "local",
  secret: "",
  apiUrl: "lanework-local:",
  name: "local",
  userId: null,
  owner: null,
};

/**
 * Whether the app is in local mode: no credential on disk and "Skip for now"
 * chosen.
 *
 * The rule `currentSession` applies, read from the two files alone.
 *
 * NOTE: Not `currentSession()`. That probes the control plane when its
 * verdict is stale, and the cloud paths below already pay for one probe in
 * {@link authorizedRecord}. A second one in front of it would move every cloud
 * read later, and let callers racing the first `load` each fetch the list
 * again.
 */
async function inLocalMode(): Promise<boolean> {
  return !(await readRecord()) && (await readLocalMode());
}

/** Signed in, or in local mode — anything else is refused. */
async function assertCanUse(): Promise<void> {
  if (await inLocalMode()) return;
  await authorizedRecord();
}

/** Local boards as the workspace list carries them, each with its folder. */
async function localList(): Promise<Workspace[]> {
  const locals = listLocalWorkspaces();
  if (!locals.length) return [];
  const folders = await readFolders(LOCAL_RECORD);
  return locals.map((workspace) =>
    localToWorkspace(workspace, folders[workspace.slug]?.[0] ?? null),
  );
}

/**
 * The local board a board call names, or null when it names a cloud one.
 *
 * NOTE: Matched by ID only (see `findLocalWorkspace`), and only once the
 * session may use the app at all: a signed-out window reads no board, local
 * or not.
 */
async function localTarget(workspaceId: string): Promise<LocalBoard | null> {
  const board = localBoard(workspaceId);
  if (!board) return null;
  await assertCanUse();
  return board;
}

/**
 * Which account a folder link keyed by `slug` is filed under.
 *
 * NOTE: The folder channels name a workspace by slug alone, and a local board
 * and a cloud one can share a slug (a moved board and its cloud copy usually
 * do). The cloud project wins that tie when signed in: it is the one the rest
 * of the app — terminals, pull requests — already resolves that slug to.
 */
async function folderRecordFor(slug: string): Promise<MachineRecord> {
  if (await inLocalMode()) return LOCAL_RECORD;
  const record = await authorizedRecord();
  const cloud =
    lastList?.session === sessionKey(record) ? lastList.workspaces : null;
  if (
    !cloud?.some((workspace) => workspace.slug === slug) &&
    findLocalWorkspace(slug, { bySlug: true })
  )
    return LOCAL_RECORD;
  return record;
}

/** The local board `key` names, as a list row with its folder. */
async function localKnown(
  key: string,
  bySlug: boolean,
): Promise<Workspace | null> {
  const found = findLocalWorkspace(key, { bySlug });
  if (!found) return null;
  const folders = await readFolders(LOCAL_RECORD);
  return localToWorkspace(found, folders[found.slug]?.[0] ?? null);
}

/** Local mode's `load`: the local list, and the selection filed under it. */
async function loadLocal(id?: string): Promise<WorkspaceSnapshot> {
  const workspaces = await localList();
  const saved = await readActive(LOCAL_RECORD);
  const selector = id ?? saved?.value;
  const active =
    (selector
      ? workspaces.find(
          (workspace) =>
            workspace.id === selector || workspace.slug === selector,
        )
      : undefined) ?? null;
  if (id !== undefined && !active)
    throw new Error(
      "This workspace is no longer available. Refresh the list and choose another.",
    );
  if (id !== undefined || saved?.by === "slug" || (saved !== null && !active))
    await writeActive(LOCAL_RECORD, {
      id: active?.id ?? null,
      slug: active?.slug ?? null,
    });
  return { workspaces, active };
}

/** Syncs running now, by local id — one click is one move. */
const syncing = new Set<string>();

/**
 * Moves a local board to the signed-in account, then opens its cloud copy
 * (FE-52/D7a).
 *
 * The folder link goes with it, so the terminal and the agent setup of the
 * project keep working on the cloud board.
 */
async function syncToCloud(localId: string): Promise<LocalSyncResult> {
  const record = await authorizedRecord();
  const store = localStore();
  const workspace = findLocalWorkspace(localId);
  if (!store || !workspace)
    throw new Error("That board is not on this machine.");
  if (syncing.has(localId))
    throw new Error("This board is already being synced.");
  syncing.add(localId);
  try {
    const paths = (await readFolders(LOCAL_RECORD))[workspace.slug] ?? [];
    const outcome = await syncLocalWorkspace(store, record, localId, {
      path: paths[0] ?? null,
    });
    await assertSameSession(record);
    // A fresh read: the account has a project it did not have a moment ago.
    lastList = null;
    const listed = await load();
    const cloud = listed.workspaces.find(
      (entry) => entry.id === outcome.cloudId && entry.origin !== "local",
    );
    const slug = cloud?.slug ?? outcome.cloudSlug;
    const linked = (await readFolders(record))[slug] ?? [];
    if (paths.length && !linked.length) await writeFolders(record, slug, paths);
    const snapshot = await load(outcome.cloudId);
    return {
      localId,
      cloudId: outcome.cloudId,
      cards: outcome.cards,
      snapshot,
    };
  } finally {
    syncing.delete(localId);
  }
}

/**
 * The list the last `load` read, and the session it was read under.
 *
 * NOTE: Only SELECTING reuses it (FE-15/D4). Without it, switching projects
 * fetches the whole list again just to write down which one was chosen — a
 * round trip per switch for an answer the renderer already has. Every other
 * read still asks the service, and the session key means a different account
 * never sees it.
 */
let lastList: { session: string; workspaces: Workspace[] } | null = null;

const sessionKey = (record: MachineRecord) =>
  [record.apiUrl, record.machineId, record.userId, record.secret].join("\n");

/**
 * The folder a terminal for `key` opens in (FE-19/D7).
 *
 * NOTE: Resolved HERE, from the links this process wrote down, never from the
 * renderer. The terminal panel names a workspace and nothing else, so a
 * renderer cannot open a shell in a folder of its choosing.
 *
 * @param key The cloud id or, for a service that sends none, the slug — the
 *   same either-or `load(id)` accepts. The folder link is keyed by slug.
 * @returns The workspace's PRIMARY folder on this machine, or null — the home
 *   folder — when it has none here or it has moved.
 */
export async function terminalFolder(key: string): Promise<string | null> {
  const { record, workspace } = await knownWorkspace(key);
  const [primary] = (await readFolders(record))[workspace.slug] ?? [];
  return primary && (await folderExists(primary)) ? primary : null;
}

/**
 * Every folder of `key` still on this machine, primary first.
 *
 * A port belongs to the project when its process runs inside one of them.
 * Resolved here, like {@link terminalFolder}, never from the renderer.
 */
export async function projectFolders(key: string): Promise<string[]> {
  const { record, workspace } = await knownWorkspace(key);
  const folders = (await readFolders(record))[workspace.slug] ?? [];
  const present = await Promise.all(
    folders.map(async (folder) =>
      (await folderExists(folder)) ? folder : null,
    ),
  );
  return present.filter((folder): folder is string => folder !== null);
}

/**
 * The workspace `key` (id or slug) names on this account, and the credential
 * that read it.
 *
 * Found in the list this process last read, or a fresh one.
 *
 * NOTE: Exported for `../readiness`, which resolves a slug the same way the
 * terminal does rather than trusting anything the renderer says about it.
 */
export async function knownWorkspace(
  key: string,
): Promise<{ record: MachineRecord; workspace: Workspace }> {
  // A local board answers with `LOCAL_RECORD`, whose folder links are the
  // local ones and whose origin no request can reach.
  if (await inLocalMode()) {
    const local = await localKnown(key, true);
    if (!local) throw new Error("That project is not on this machine.");
    return { record: LOCAL_RECORD, workspace: local };
  }
  const byId = await localKnown(key, false);
  if (byId) return { record: LOCAL_RECORD, workspace: byId };
  const record = await authorizedRecord();
  const known =
    lastList?.session === sessionKey(record)
      ? lastList.workspaces
      : await fetchWorkspaces(record);
  const workspace = known.find(
    (entry) => entry.id === key || entry.slug === key,
  );
  if (workspace) return { record, workspace };
  const bySlug = await localKnown(key, true);
  if (bySlug) return { record: LOCAL_RECORD, workspace: bySlug };
  throw new Error("That project is not on this account.");
}

/**
 * The account's projects, for native surfaces.
 *
 * Never reuses another account's list.
 */
export async function menuBarWorkspaces(): Promise<Workspace[]> {
  if (await inLocalMode()) return localList();
  const record = await authorizedRecord();
  const cloud =
    lastList?.session === sessionKey(record)
      ? lastList.workspaces
      : await fetchWorkspaces(record);
  return [...cloud, ...(await localList())];
}

/**
 * The workspace list, and which one is selected.
 *
 * NOTE: Selection is by CLOUD WORKSPACE ID, because every board call is
 * `/v1/boards/:workspaceId/…`. Remembering the slug instead would mean
 * resolving it to an id on every start, from a list that may not have loaded
 * yet. A `v1` file that still names a slug is resolved once and rewritten.
 */
async function load(id?: string): Promise<WorkspaceSnapshot> {
  // Local mode lists the local boards and nothing else, and asks the control
  // plane nothing.
  if (await inLocalMode()) return loadLocal(id);
  const record = await authorizedRecord();
  const session = sessionKey(record);
  // Local boards stay in the list, after the account's own (FE-52/D6a).
  const locals = await localList();
  const matches = (entry: Workspace) => entry.id === id || entry.slug === id;
  const known =
    id !== undefined && lastList?.session === session
      ? lastList.workspaces
      : null;
  // A selection the remembered list does not know is read fresh: it may be a
  // project made on another machine since. A LOCAL selection needs no fresh
  // read of the account.
  const cloud =
    known && (known.some(matches) || locals.some(matches))
      ? known
      : await fetchWorkspaces(record);
  lastList = { session, workspaces: cloud };
  const workspaces = [...cloud, ...locals];
  const saved = await readActive(record);
  await assertSameSession(record);

  // NOTE: A selector is matched against the id AND the slug. The renderer
  // sends `id ?? slug`, and against a service that predates the id field
  // every id is null. Matching on the id alone would make every Open button
  // answer "this workspace is no longer available", the one sentence that is
  // certainly false when the row was just listed.
  const selector = id ?? saved?.value;
  const active =
    (selector
      ? workspaces.find(
          (workspace) =>
            workspace.id === selector || workspace.slug === selector,
        )
      : undefined) ?? null;

  if (id !== undefined && !active)
    throw new Error(
      "This workspace is no longer available. Refresh the list and choose another.",
    );
  // Write when the caller chose one, when an older shape was just resolved,
  // or when what was saved no longer exists.
  if (id !== undefined || saved?.by === "slug" || (saved !== null && !active))
    await writeActive(record, {
      id: active?.id ?? null,
      slug: active?.slug ?? null,
    });
  await assertSameSession(record);
  return { workspaces, active };
}

/** The counts under `query`, and the unfiltered total the rail shows. */
async function countsFor(
  record: MachineRecord,
  workspaceId: string,
  query: BoardQuery,
): Promise<{ stats: BoardStats; total: number } | null> {
  const filtered = Object.values(query.filters).some(Boolean);
  const [stats, all] = await Promise.all([
    fetchStats(record, workspaceId, query.filters),
    filtered ? fetchStats(record, workspaceId, {}) : null,
  ]);
  if (!stats) return null;
  return { stats, total: (all ?? stats).total };
}

/**
 * A board, or the last good copy of it with `stale: true`.
 *
 * Read one group at a time: the counts, and the first page of every group
 * `query` draws — all at once, not one after another.
 *
 * NOTE: It never answers with an empty board on failure. That is the reason
 * the cache exists: a board that reads as empty invites somebody to start
 * typing a card that already exists, and no error dialog undoes that.
 *
 * - The groups are planned from the SAVED copy's lanes when there is one, so
 *   they go out alongside the config instead of waiting for it. A lane the
 *   config then adds is read right after; one it no longer has is dropped.
 * - A service without `/stats` gets the whole-board read. Its counts can only
 *   come from having every card, and the board stays correct against an API
 *   that has not been deployed yet.
 */
async function board(
  workspaceId: string,
  query: BoardQuery = DEFAULT_BOARD_QUERY,
): Promise<BoardView> {
  const record = await authorizedRecord();
  const startedAt = Date.now();
  try {
    const saved = await readBoardCache(record, workspaceId);
    const configRead = fetchBoardConfig(record, workspaceId);
    const countsRead = countsFor(record, workspaceId, query);
    // Settled into the read below; a failure here must not go unhandled
    // while the groups are still out.
    configRead.catch(() => undefined);
    countsRead.catch(() => undefined);

    const read = (specs: GroupSpec[]) =>
      Promise.all(
        specs.map(async (spec) => ({
          spec,
          page: await fetchGroup(record, workspaceId, spec),
        })),
      );
    const planned = saved
      ? groupSpecs(query, saved.columns, saved.categories)
      : groupSpecs(
          query,
          (await configRead).columns,
          (await configRead).categories,
        );
    const firstPages = read(planned);
    firstPages.catch(() => undefined);

    const [config, counts] = await Promise.all([configRead, countsRead]);
    let cards: BoardCard[];
    let groups: BoardView["groups"];
    let head: number | null = null;
    if (counts) {
      const wanted = groupSpecs(query, config.columns, config.categories);
      const have = new Set(planned.map((spec) => spec.key));
      const pages = [
        ...(await firstPages),
        ...(await read(wanted.filter((spec) => !have.has(spec.key)))),
      ].filter(({ spec }) => wanted.some((entry) => entry.key === spec.key));
      const byId = new Map<string, BoardCard>();
      for (const { page } of pages)
        for (const card of page.cards) byId.set(card.id, card);
      cards = [...byId.values()];
      const heads = pages.flatMap(({ page }) =>
        page.head === null ? [] : [page.head],
      );
      head =
        heads.length === pages.length && heads.length
          ? Math.min(...heads)
          : null;
      groups = Object.fromEntries(
        pages.map(({ spec, page }) => [
          spec.key,
          { cursor: page.cursor, limit: spec.limit },
        ]),
      );
    } else {
      cards = await fetchCards(record, workspaceId);
      groups = undefined;
    }
    await assertSameSession(record);
    const view: BoardView = {
      workspaceId,
      columns: config.columns,
      categories: config.categories,
      labels: config.labels,
      members: config.members,
      cards,
      migrated: Boolean(config.migratedAt),
      fetchedAt: new Date().toISOString(),
      stale: false,
      stats: counts?.stats ?? null,
      total: counts?.total ?? null,
      query: boardQueryKey(query),
      groups,
      head,
    };
    await writeBoardCache(record, workspaceId, view);
    return view;
  } catch (error) {
    // Logged even though the caller is answered normally. Serving the cache
    // is the right answer and a SILENT one: "Offline — showing a saved board"
    // reads the same for a dropped connection, an HTTP 500, a 15s timeout and
    // a changed session, and this catch is the last place that still knows
    // which of them it was. The elapsed time is here for the same reason: a
    // failure at ~15000ms is the request timing out, not the network being
    // off.
    console.error(
      `Board ${workspaceId} fell back to the cache after ${Date.now() - startedAt}ms:`,
      error,
    );
    const cached = await readBoardCache(record, workspaceId);
    if (cached) return cached;
    throw error;
  }
}

/**
 * A board query off the wire, checked field by field.
 *
 * NOTE: Every value ends up in a URL the service parses, so each is held to a
 * short, non-empty string here; an unknown grouping or a field this app never
 * sends is dropped.
 *
 * @throws When the query or one of its filters is malformed.
 */
function requireQuery(value: unknown): BoardQuery {
  if (value === undefined) return DEFAULT_BOARD_QUERY;
  if (!value || typeof value !== "object")
    throw new Error("A valid board query is required");
  const raw = value as { groupBy?: unknown; filters?: unknown };
  const groupBy =
    raw.groupBy === "category" || raw.groupBy === "priority"
      ? raw.groupBy
      : "status";
  const filters: BoardQuery["filters"] = {};
  const given =
    raw.filters && typeof raw.filters === "object"
      ? (raw.filters as Record<string, unknown>)
      : {};
  for (const field of ["status", "category", "priority", "tag"] as const) {
    const entry = given[field];
    if (entry === undefined || entry === null || entry === "") continue;
    if (typeof entry !== "string" || entry.length > 40 || !entry.trim())
      throw new Error("A valid board query is required");
    filters[field] = entry;
  }
  return { groupBy, filters };
}

/**
 * Whether this workspace has a folder on this machine, and what is in it.
 *
 * A linked folder that has since moved is `missing`, not `none`. Answering
 * "no folder linked" would invite the user to link it again, and tell them
 * nothing about why the one they chose stopped working.
 */
async function folderState(slug: string): Promise<LocalFolderState> {
  const record = await folderRecordFor(slug);
  // The PRIMARY, which is the first. Every surface below this one — the
  // migration reader, "open in file manager" — is about one folder, and the
  // list says which one that is.
  const [path, ...others] = (await readFolders(record))[slug] ?? [];
  if (!path) return { kind: "none" };
  // `readLocalFolder` can describe a folder that is not a project; a folder
  // that is not THERE is the one case it cannot, so it is checked first.
  if (!(await folderExists(path))) return { kind: "missing", path };
  return { kind: "linked", summary: await readLocalFolder(path), others };
}

const NO_FOLDER =
  "No folder is linked to this workspace on this machine. Choose one first.";

/** The migration plan for whichever folder is linked to this workspace. */
async function planFor(workspaceId: string): Promise<{
  plan: Awaited<ReturnType<typeof planMigration>> | null;
  folder: string | null;
}> {
  const record = await authorizedRecord();
  const { workspaces } = await load();
  // NOTE: Matched on the id OR the slug, because the link is keyed by slug and
  // the caller addresses a board by id. Looking up one from the other here
  // keeps the renderer from having to know both.
  const workspace = workspaces.find(
    (entry) => entry.id === workspaceId || entry.slug === workspaceId,
  );
  const folder = workspace
    ? ((await readFolders(record))[workspace.slug]?.[0] ?? null)
    : null;
  if (!folder) return { plan: null, folder: null };
  return { plan: await planMigration(folder), folder };
}

/**
 * How many cards the board should hold if the last run is what it says.
 *
 * NOTE: Every record the run ACCOUNTED FOR, not just the new ones. A re-run
 * reports a card that is already there as `skipped`, so counting `imported`
 * alone makes the second seal of the same project fail by the number of cards
 * that did land. `conflict` and `failed` are excluded for the mirror reason:
 * those are the records the board does not hold.
 */
function sealableCount(summary: Record<string, number>): number {
  return (
    (summary.imported ?? 0) + (summary.updated ?? 0) + (summary.skipped ?? 0)
  );
}

/**
 * Reads an edit off the wire, field by field.
 *
 * NOTE: An allow-list, not a shape check. The renderer is a web origin:
 * whatever it sends reaches the board under this machine's credential, so the
 * set of fields a person can change from a window is decided HERE and nowhere
 * else. An unknown key is a refusal rather than something to drop quietly: a
 * caller sending one has a bug, and ignoring it hides the bug in a write that
 * appears to work.
 *
 * @throws On an unknown field, or a value a field does not take.
 */
function parsePatch(value: unknown): BoardCardPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("An edit is required");
  const row = value as Record<string, unknown>;
  const allowed = [
    "title",
    "body",
    "priority",
    "tags",
    "categoryKey",
    "assignees",
    "parentId",
    "dueAt",
    "estimate",
    "type",
  ];
  const keys = Object.keys(row);
  if (!keys.length) throw new Error("An edit must change something");
  for (const key of keys)
    if (!allowed.includes(key)) throw new Error(`Cannot change "${key}"`);

  const patch: BoardCardPatch = {};
  if ("title" in row) {
    if (
      typeof row.title !== "string" ||
      !row.title.trim() ||
      row.title.length > 500
    )
      throw new Error("A card needs a title");
    patch.title = row.title.trim();
  }
  if ("body" in row) {
    if (typeof row.body !== "string" || row.body.length > 100_000)
      throw new Error("That description is too long");
    patch.body = row.body;
  }
  if ("priority" in row) {
    if (
      !(
        row.priority === null ||
        row.priority === "low" ||
        row.priority === "medium" ||
        row.priority === "high"
      )
    )
      throw new Error("That priority is not one this board uses");
    patch.priority = row.priority;
  }
  if ("tags" in row) {
    if (
      !Array.isArray(row.tags) ||
      row.tags.length > 20 ||
      !row.tags.every(
        (tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 100,
      )
    )
      throw new Error("Those tags cannot be used");
    patch.tags = row.tags as string[];
  }
  if ("categoryKey" in row) {
    if (
      !(
        row.categoryKey === null ||
        (typeof row.categoryKey === "string" &&
          row.categoryKey.trim().length > 0 &&
          row.categoryKey.length <= 200)
      )
    )
      throw new Error("That category cannot be used");
    patch.categoryKey = row.categoryKey as string | null;
  }
  if ("assignees" in row) {
    // NOTE: BOTH lists are required, even when only one is changing. The
    // service replaces the whole set, so accepting `{ users }` alone would
    // clear every agent assignment as a side effect of naming a person.
    const value = row.assignees;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("An assignment needs users and agents");
    const each = value as Record<string, unknown>;
    const list = (raw: unknown) =>
      Array.isArray(raw) &&
      raw.length <= 50 &&
      raw.every(
        (ref) => typeof ref === "string" && ref.length > 0 && ref.length <= 200,
      )
        ? (raw as string[])
        : null;
    const users = list(each.users);
    const agents = list(each.agents);
    if (!users || !agents) throw new Error("Those assignees cannot be used");
    patch.assignees = { users, agents };
  }
  if ("parentId" in row) {
    if (
      !(
        row.parentId === null ||
        (typeof row.parentId === "string" &&
          row.parentId.trim().length > 0 &&
          row.parentId.length <= 200)
      )
    )
      throw new Error("That parent cannot be used");
    patch.parentId = row.parentId as string | null;
  }
  if ("dueAt" in row) {
    // NOTE: Parsed, not just shape-checked. The service takes an instant, and
    // a string it cannot read comes back as a 400 for a field the user set
    // from a date picker — a bug they can do nothing about.
    if (
      !(
        row.dueAt === null ||
        (typeof row.dueAt === "string" &&
          Number.isFinite(Date.parse(row.dueAt)))
      )
    )
      throw new Error("That due date cannot be used");
    patch.dueAt = row.dueAt as string | null;
  }
  if ("estimate" in row) {
    if (
      !(
        row.estimate === null ||
        (typeof row.estimate === "number" &&
          Number.isInteger(row.estimate) &&
          row.estimate >= 0 &&
          row.estimate <= 1000)
      )
    )
      throw new Error("That estimate cannot be used");
    patch.estimate = row.estimate as number | null;
  }
  if ("type" in row) {
    if (row.type !== "epic" && row.type !== "issue" && row.type !== "task")
      throw new Error("That card type is not one this board uses");
    patch.type = row.type;
  }
  return patch;
}

/**
 * A comment body from the renderer.
 *
 * - Its own check rather than `requireId`, whose message names a workspace
 *   and a card. This argument is a sentence somebody typed, and "a card is
 *   required" for an empty comment box explains nothing.
 * - The cap mirrors the service's `MAX_COMMENT`. Refusing here is the same
 *   answer, sooner, without a round trip that was never going to succeed.
 */
function commentBody(args: unknown[], expected: number): string {
  if (args.length !== expected) throw new Error("A comment is required");
  const value = args[expected - 1];
  if (typeof value !== "string" || !value.trim())
    throw new Error("A comment cannot be empty");
  if (value.length > 20_000) throw new Error("That comment is too long");
  return value.trim();
}

/**
 * A file reference on its way to a card.
 *
 * NOTE: A REFERENCE, and this channel never reads it. The service stores
 * metadata and hands the string back untouched, so nothing here opens, stats
 * or resolves what the renderer names. That keeps this from being a channel
 * that reads any file the renderer can spell.
 */
function parseAttachmentDraft(value: unknown): BoardAttachmentDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A file is required");
  const row = value as Record<string, unknown>;
  const name = row.name;
  const reference = row.reference;
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw new Error("That file needs a name");
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 2000
  )
    throw new Error("That file needs a path or a link");
  const sizeBytes = row.sizeBytes;
  if (
    sizeBytes !== undefined &&
    sizeBytes !== null &&
    !(
      typeof sizeBytes === "number" &&
      Number.isInteger(sizeBytes) &&
      sizeBytes >= 0
    )
  )
    throw new Error("That file size cannot be used");
  const mimeType = row.mimeType;
  if (
    mimeType !== undefined &&
    mimeType !== null &&
    !(typeof mimeType === "string" && mimeType.length <= 200)
  )
    throw new Error("That file type cannot be used");
  return {
    name: name.trim(),
    reference: reference.trim(),
    mimeType: (mimeType as string | null | undefined) ?? null,
    sizeBytes: (sizeBytes as number | null | undefined) ?? null,
  };
}

/**
 * A whole checklist on the way to the board.
 *
 * The board's own limits, restated rather than deferred to. The API answers a
 * malformed list with `checklist[7].text is 2311 characters` — a good
 * message, and one that arrives after a round trip that was never going to
 * succeed. Refusing here is the same answer, sooner, and it keeps a renderer
 * bug from looking like a service failure.
 */
function parseChecklistDraft(value: unknown): BoardChecklistDraft[] {
  if (!Array.isArray(value)) throw new Error("A checklist must be a list");
  if (value.length > CHECKLIST_LIMITS.items)
    throw new Error(
      `A checklist holds at most ${CHECKLIST_LIMITS.items} items`,
    );
  const keys = new Set<string>();
  return value.map((entry, index) => {
    const at = `Checklist item ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${at} is not an item`);
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row))
      if (
        ![
          "key",
          "section",
          "text",
          "checked",
          "note",
          "group",
          "stream",
        ].includes(key)
      )
        throw new Error(`${at} cannot carry "${key}"`);

    if (typeof row.text !== "string" || !row.text.trim())
      throw new Error(`${at} needs text`);
    // Two messages, not one. "needs text" for something 2311 characters long
    // sends the reader looking for an empty field that is not there.
    if (row.text.trim().length > CHECKLIST_LIMITS.text)
      throw new Error(
        `${at} is ${row.text.trim().length} characters; the limit is ${CHECKLIST_LIMITS.text}`,
      );

    const draft: BoardChecklistDraft = { text: row.text.trim() };
    if (row.key !== undefined && row.key !== null) {
      if (
        typeof row.key !== "string" ||
        !row.key.trim() ||
        row.key.length > CHECKLIST_LIMITS.key
      )
        throw new Error(`${at} has a malformed key`);
      // A duplicate key would silently drop one of the two rows on the board.
      if (keys.has(row.key))
        throw new Error(`Two items are keyed "${row.key}"`);
      keys.add(row.key);
      draft.key = row.key;
    }
    if (row.section !== undefined) {
      if (
        !CHECKLIST_SECTIONS.includes(
          row.section as (typeof CHECKLIST_SECTIONS)[number],
        )
      )
        throw new Error(`${at} must be in ${CHECKLIST_SECTIONS.join(" or ")}`);
      draft.section = row.section as BoardChecklistDraft["section"];
    }
    if (row.checked !== undefined) {
      if (typeof row.checked !== "boolean")
        throw new Error(`${at} has an invalid state`);
      draft.checked = row.checked;
    }
    if (row.note !== undefined && row.note !== null) {
      if (
        typeof row.note !== "string" ||
        row.note.length > CHECKLIST_LIMITS.note
      )
        throw new Error(`${at} has an invalid note`);
      draft.note = row.note;
    }
    if (row.group !== undefined && row.group !== null) {
      if (
        typeof row.group !== "string" ||
        !row.group.trim() ||
        row.group.length > CHECKLIST_LIMITS.key
      )
        throw new Error(`${at} has an invalid group`);
      draft.group = row.group;
    }
    // The stream a verify item proves, passed through so a save keeps the
    // tag; the API checks it against the card's streams.
    if (row.stream !== undefined) {
      if (
        row.stream !== null &&
        (typeof row.stream !== "string" || !/^W\d{1,3}$/.test(row.stream))
      )
        throw new Error(`${at} has an invalid stream`);
      draft.stream = row.stream;
    }
    return draft;
  });
}

/**
 * The folders a create call names, resolved to paths.
 *
 * NOTE: An id this run never handed out is a REFUSAL, not a folder to skip.
 * The only way to hold one is to have picked the folder in this app, so an
 * unknown id means the window is asking for something a person never chose.
 * A project quietly created with fewer folders than the dialog listed is
 * worse than one that was not created at all.
 *
 * @throws When an id is malformed or was not handed out by this run.
 */
function parseFolderIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Those source folders cannot be used");
  return value.map((id) => {
    if (typeof id !== "string" || !id.trim())
      throw new Error("Those source folders cannot be used");
    const path = folderFor(id);
    if (!path)
      throw new Error(
        "One of those folders is no longer available. Add it again.",
      );
    return path;
  });
}

/** `{after}` or `{before}` and nothing else — exactly one neighbour. */
function parsePlacement(value: unknown): BoardPlacement | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("A placement must name one neighbouring card");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 1 || !(keys[0] === "after" || keys[0] === "before"))
    throw new Error("A placement must name one neighbouring card");
  const id = row[keys[0]];
  if (typeof id !== "string" || !id.trim() || id.length > 200)
    throw new Error("A placement must name one neighbouring card");
  return keys[0] === "after" ? { after: id } : { before: id };
}

/**
 * `count` ids off the wire, each 1-200 characters.
 *
 * NOTE: `.` and `..` are refused as well as blanks (FE-78/D7). These become
 * path segments of a request sent with this machine's credential, and a URL
 * parser collapses a dot segment: `items/..` would address a different route
 * than the one the handler means.
 */
function requireId(args: unknown[], count: number): string[] {
  if (
    args.length !== count ||
    !args.every(
      (arg) =>
        typeof arg === "string" &&
        arg.trim() &&
        arg.length <= 200 &&
        arg !== "." &&
        arg !== "..",
    )
  )
    throw new Error("A valid workspace and card are required");
  return args as string[];
}

/** The board's own key shape, mirrored from the service's `board-input.ts`. */
const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A card draft off the wire, checked field by field.
 *
 * - The caps are the SERVICE's own — title 200, body 120000, keys 40, tags
 *   32 × 40. A tampered renderer is what this boundary exists for, and a
 *   limit invented here would either refuse what the board accepts or
 *   forward what it will refuse.
 * - NOTE: Unknown fields are DROPPED rather than forwarded. Only what this
 *   app's own composer can set may reach the board through it: passing the
 *   object straight through would make this channel a way to set `parentId`,
 *   `metadata` or a `source` that no screen in the app can show.
 */
function parseDraft(value: unknown): BoardCardDraft {
  if (!value || typeof value !== "object")
    throw new Error("A card needs a title");
  const raw = value as Record<string, unknown>;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 200)
    throw new Error("A card needs a title of 1-200 characters");

  const key = (input: unknown, field: string): string | undefined => {
    if (input === undefined || input === null || input === "") return undefined;
    if (typeof input !== "string" || input.length > 40 || !KEY.test(input))
      throw new Error(`That ${field} is not a key this board can use`);
    return input;
  };

  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (body.length > 120_000) throw new Error("That description is too long");

  const priority =
    raw.priority === "low" ||
    raw.priority === "medium" ||
    raw.priority === "high"
      ? raw.priority
      : undefined;
  if (raw.priority !== undefined && raw.priority !== null && !priority)
    throw new Error("Priority must be low, medium or high");

  let tags: string[] | undefined;
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) throw new Error("Tags must be a list");
    tags = raw.tags.map((tag) => {
      if (typeof tag !== "string" || !tag.trim() || tag.length > 40)
        throw new Error("Each tag must be 1-40 characters");
      return tag.trim();
    });
    if (tags.length > 32) throw new Error("That is too many tags");
  }

  return {
    title,
    ...(body ? { body } : {}),
    ...(key(raw.categoryKey, "category") !== undefined
      ? { categoryKey: key(raw.categoryKey, "category") }
      : {}),
    ...(key(raw.columnKey, "status") !== undefined
      ? { columnKey: key(raw.columnKey, "status") }
      : {}),
    ...(priority ? { priority } : {}),
    ...(tags ? { tags } : {}),
  };
}

export function registerWorkspaces(devUrl?: string): void {
  handle(workspaceChannels.load, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return load();
  });
  handle(workspaceChannels.select, devUrl, (args) => {
    const [id] = requireId(args, 1);
    return load(id);
  });
  handle(workspaceChannels.icon, devUrl, async (args) => {
    const [workspaceId] = requireId(args.slice(0, 1), 1);
    const key = args[1];
    if (
      args.length !== 2 ||
      !(key === null || (typeof key === "string" && key.length <= 300))
    )
      throw new Error("A valid workspace is required");
    // A local board has no icon: the service is what reads one.
    if (await localTarget(workspaceId)) return null;
    return workspaceIcon(await authorizedRecord(), workspaceId, key);
  });
  handle(
    workspaceChannels.createWorkspace,
    devUrl,
    async (args): Promise<WorkspaceSnapshot> => {
      if (
        args.length > 2 ||
        typeof args[0] !== "string" ||
        !args[0].trim() ||
        args[0].length > 200
      )
        throw new Error("A project name is required");
      const name = args[0].trim();
      // NOTE: Ids, resolved HERE against folders this app's own chooser
      // handed out. A create call cannot name a path, so it cannot link a
      // folder the user never picked — see `folder-chooser.ts`.
      const paths = parseFolderIds(args[1]);
      // In local mode a new project is a local board: created on this
      // machine, linked to its folders, and opened, like the cloud one.
      if (await inLocalMode()) {
        const created = writeLocal((store) =>
          store.createWorkspace({ name, slug: slugify(name) }),
        );
        if (paths.length) await writeFolders(LOCAL_RECORD, created.slug, paths);
        return load(created.id);
      }
      const record = await authorizedRecord();
      const created = await createWorkspace(record, {
        slug: slugify(name),
        name,
        // NOTE: The PRIMARY folder, so the account records where this project
        // lives on this machine from the moment it exists. Every other
        // surface reads that back as `workspace.path`; leaving it unset would
        // make a project created here look, to a second machine, like one
        // nobody has a checkout of.
        ...(paths[0] ? { path: paths[0] } : {}),
      });
      // NOTE: Linked under the slug the SERVICE answered with, not the one
      // this app derived. They are the same today and the folder link is
      // keyed by slug; deriving it twice is how the two would eventually
      // disagree, and a link under a slug nothing looks up is a folder that
      // vanished.
      if (paths.length) await writeFolders(record, created.slug, paths);
      // Created AND opened, in one act. A project that appeared in the list
      // and left the user to click "Open" would be two steps for one
      // intention, and `load` is what writes the selection down — so this
      // also survives a relaunch, which is the whole promise of the picker.
      return load(created.id);
    },
  );
  handle(
    workspaceChannels.renameWorkspace,
    devUrl,
    async (args): Promise<WorkspaceSnapshot> => {
      // Its own check rather than `requireId`: that helper's message names a
      // workspace and a card, and the second argument here is a human's typing.
      if (
        args.length !== 2 ||
        !args.every(
          (arg) => typeof arg === "string" && arg.trim() && arg.length <= 200,
        )
      )
        throw new Error("A project and a new name are required");
      const [id, name] = args as [string, string];
      if (await localTarget(id)) {
        // NOTE: The NAME only, as on the cloud: the folder link is keyed by
        // slug, and a rename that moved the slug would strand it.
        writeLocal((store) => store.updateWorkspace(id, { name: name.trim() }));
        return load();
      }
      const record = await authorizedRecord();
      await renameWorkspace(record, id, name.trim());
      // NOTE: `load()`, NOT `load(id)`. Passing the id would write it down as
      // the selection, so renaming a project from Settings would quietly open
      // it — and the one being renamed is usually not the one on screen.
      // Nothing local needs rewriting either, unlike the delete below: the
      // service will not change a slug, so the folder link and the saved
      // selection still name this project.
      return load();
    },
  );
  handle(
    workspaceChannels.reorderWorkspaces,
    devUrl,
    async (args): Promise<WorkspaceSnapshot> => {
      const [ids] = args;
      if (
        args.length !== 1 ||
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 500 ||
        !ids.every((id) => typeof id === "string" && id && id.length <= 64)
      )
        throw new Error("A list of project ids is required");
      // Local boards have no saved order — they follow the account's
      // projects, oldest first — and the service refuses an order naming an
      // id it does not hold, so only the cloud ids are sent.
      if (await inLocalMode()) return load();
      const cloudIds = (ids as string[]).filter(
        (id) => !findLocalWorkspace(id),
      );
      const record = await authorizedRecord();
      if (cloudIds.length) await reorderWorkspaces(record, cloudIds);
      // `load()`, not `load(id)`: a fresh read, in the order the service now
      // answers with, and no change to which project is open.
      return load();
    },
  );
  handle(
    workspaceChannels.deleteWorkspace,
    devUrl,
    async (args): Promise<WorkspaceSnapshot> => {
      // NOTE: BOTH keys, and they are not redundant. The service deletes by
      // cloud id — a slug is refused with a 400 — while the folder link on
      // this machine is keyed by slug, and main holds no id→slug map to
      // derive one from without asking the account a second time.
      const [id, slug] = requireId(args, 2);
      const local = await localTarget(id);
      if (local) {
        // A tombstone: its cards stay in the file, unreachable, like the
        // cloud's own delete leaves an audit trail behind.
        writeLocal((store) => store.deleteWorkspace(id));
        await writeFolders(LOCAL_RECORD, local.workspace.slug, null);
        return load();
      }
      const record = await authorizedRecord();
      await deleteWorkspace(record, id);
      // `load` re-reads the account and drops a saved selection that no longer
      // exists, which is the state deleting the open project leaves.
      const snapshot = await load();
      // NOTE: Checked BEFORE the local link is dropped, and this is not
      // belt-and-braces. A service one release behind still answers the
      // slug-keyed route, whose validator ACCEPTS a uuid — so it removes
      // nothing and replies 200. Trusting that would report a success that
      // never happened and take the folder link with it, leaving a project on
      // the account that this machine can no longer point at anything.
      if (snapshot.workspaces.some((workspace) => workspace.id === id))
        throw new Error(
          "The service did not delete that project. Update it, then try again.",
        );
      // NOTE: The local link goes with it. A folder still linked to a slug the
      // account no longer has is a row that can never be reached again, and
      // the next project to take that slug would inherit somebody else's
      // folder.
      await writeFolders(record, slug, null);
      return snapshot;
    },
  );
  handle(workspaceChannels.board, devUrl, async (args) => {
    if (args.length < 1 || args.length > 2)
      throw new Error("A valid workspace is required");
    const [workspaceId] = requireId(args.slice(0, 1), 1);
    const query = requireQuery(args[1]);
    const local = await localTarget(workspaceId);
    if (local) return local.view(query);
    return board(workspaceId, query);
  });
  handle(workspaceChannels.search, devUrl, async (args) => {
    // The query is typing, not an id: `..` is a search like any other, so
    // only the workspace goes through `requireId`.
    if (args.length !== 2) throw new Error("A valid workspace is required");
    const [workspaceId] = requireId(args.slice(0, 1), 1);
    const query = args[1];
    if (
      typeof query !== "string" ||
      query.trim().length < 2 ||
      query.length > 100
    )
      throw new Error("A search is 2 to 100 characters");
    const local = await localTarget(workspaceId);
    if (local) return local.search(query.trim());
    return searchCards(await authorizedRecord(), workspaceId, query.trim());
  });
  handle(workspaceChannels.more, devUrl, async (args) => {
    if (args.length !== 4) throw new Error("A valid board group is required");
    const [workspaceId, group, cursor] = requireId(
      [args[0], args[2], args[3]],
      3,
    );
    const query = requireQuery(args[1]);
    const local = await localTarget(workspaceId);
    if (local) return local.more();
    const record = await authorizedRecord();
    // NOTE: The group is re-derived from the board's lanes rather than trusted
    // as a URL fragment: a renderer can only ask for a group its query draws.
    const config = await readBoardCache(record, workspaceId);
    const spec = groupSpecs(
      query,
      config?.columns ?? [],
      config?.categories ?? [],
    ).find((entry) => entry.key === group);
    if (!spec) throw new Error("That group is not on this board");
    return fetchGroup(record, workspaceId, spec, cursor);
  });
  handle(workspaceChannels.stats, devUrl, async (args) => {
    if (args.length !== 2) throw new Error("A valid workspace is required");
    const [workspaceId] = requireId(args.slice(0, 1), 1);
    const query = requireQuery(args[1]);
    const local = await localTarget(workspaceId);
    if (local) return local.stats(query);
    return countsFor(await authorizedRecord(), workspaceId, query);
  });
  handle(workspaceChannels.presence, devUrl, async (args) => {
    const [workspaceId] = requireId(args, 1);
    if (await localTarget(workspaceId)) cloudOnly("Agent presence");
    return fetchPresence(await authorizedRecord(), workspaceId);
  });
  handle(workspaceChannels.checkpoint, devUrl, async (args) => {
    const [workspaceId, cardId] = requireId(args, 2);
    const local = await localTarget(workspaceId);
    if (local) return local.checkpoint(cardId);
    return fetchCheckpoint(await authorizedRecord(), workspaceId, cardId);
  });
  handle(workspaceChannels.card, devUrl, async (args): Promise<BoardCard> => {
    const [workspaceId, cardId] = requireId(args, 2);
    const local = await localTarget(workspaceId);
    if (local) return local.card(cardId);
    return fetchCard(await authorizedRecord(), workspaceId, cardId);
  });
  handle(
    workspaceChannels.lookup,
    devUrl,
    async (args): Promise<BoardCard | null> => {
      const [workspaceId, taskId] = requireId(args, 2);
      const local = await localTarget(workspaceId);
      if (local) return local.lookup(taskId);
      return lookupCard(await authorizedRecord(), workspaceId, taskId);
    },
  );
  handle(
    workspaceChannels.update,
    devUrl,
    async (args): Promise<BoardWrite> => {
      if (
        args.length !== 4 ||
        typeof args[3] !== "number" ||
        !Number.isInteger(args[3])
      )
        throw new Error("A card, an edit and a revision are required");
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      // NOTE: Parsed BEFORE the session is resolved. Inline as an argument it
      // would run after `await authorizedRecord()`, so a malformed edit from a
      // signed-out window would be answered "sign in" — advice that cannot
      // fix it, and which hides a caller's bug behind a state the caller will
      // eventually leave.
      const patch = parsePatch(args[2]);
      const local = await localTarget(workspaceId);
      if (local) return local.update(cardId, patch, args[3]);
      return updateCard(
        await authorizedRecord(),
        workspaceId,
        cardId,
        patch,
        args[3],
      );
    },
  );
  handle(workspaceChannels.move, devUrl, async (args): Promise<BoardWrite> => {
    // NOTE: Four arguments always. `columnKey` is null for a reorder inside
    // one lane and `placement` is null for an append, and a channel whose
    // argument count varied would make "is this call well-formed?"
    // unanswerable here.
    if (args.length !== 4)
      throw new Error("A card and a destination are required");
    if (!(args[2] === null || typeof args[2] === "string"))
      throw new Error("A card and a destination are required");
    const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
    const columnKey = args[2] === null ? null : requireId([args[2]], 1)[0];
    const placement = parsePlacement(args[3]);
    if (columnKey === null && !placement)
      throw new Error("A move needs a column or a placement");
    const local = await localTarget(workspaceId);
    if (local) return local.move(cardId, columnKey, placement);
    return moveCard(
      await authorizedRecord(),
      workspaceId,
      cardId,
      columnKey,
      placement,
    );
  });
  handle(
    workspaceChannels.changes,
    devUrl,
    async (args): Promise<BoardChanges> => {
      if (
        args.length !== 2 ||
        typeof args[1] !== "number" ||
        !Number.isInteger(args[1]) ||
        args[1] < 0
      )
        throw new Error("A workspace and a cursor are required");
      const [workspaceId] = requireId(args.slice(0, 1), 1);
      const local = await localTarget(workspaceId);
      if (local) return local.changes(args[1]);
      return fetchChanges(await authorizedRecord(), workspaceId, args[1]);
    },
  );
  handle(
    workspaceChannels.toggle,
    devUrl,
    async (args): Promise<BoardWrite> => {
      if (
        args.length !== 5 ||
        typeof args[3] !== "boolean" ||
        typeof args[4] !== "number" ||
        !Number.isInteger(args[4])
      )
        throw new Error(
          "A card, a checklist key, a state and a revision are required",
        );
      const [workspaceId, cardId, key] = requireId(args.slice(0, 3), 3);
      const local = await localTarget(workspaceId);
      if (local) return local.toggle(cardId, key, args[3], args[4]);
      return toggleChecklistItem(
        await authorizedRecord(),
        workspaceId,
        cardId,
        key,
        args[3],
        args[4],
      );
    },
  );
  handle(
    workspaceChannels.setChecklist,
    devUrl,
    async (args): Promise<BoardWrite> => {
      if (
        args.length !== 4 ||
        typeof args[3] !== "number" ||
        !Number.isInteger(args[3])
      )
        throw new Error("A card, a checklist and a revision are required");
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      // Shape first, session second: a malformed list is the caller's bug and
      // must not be reported as "sign in".
      const items = parseChecklistDraft(args[2]);
      const local = await localTarget(workspaceId);
      if (local) return local.setChecklist(cardId, items, args[3]);
      return replaceChecklist(
        await authorizedRecord(),
        workspaceId,
        cardId,
        items,
        args[3],
      );
    },
  );
  handle(
    workspaceChannels.activity,
    devUrl,
    async (args): Promise<BoardActivityPage> => {
      // NOTE: Three arguments always, with `null` for "the first page". The
      // sender check reads argument COUNT, so a call that sometimes sends two
      // and sometimes three is one no rule here can state.
      if (
        args.length !== 3 ||
        !(args[2] === null || typeof args[2] === "string")
      )
        throw new Error("A card and a cursor are required");
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      if (await localTarget(workspaceId)) cloudOnly("A card's activity");
      return fetchActivity(
        await authorizedRecord(),
        workspaceId,
        cardId,
        args[2],
      );
    },
  );
  handle(
    workspaceChannels.comment,
    devUrl,
    async (args): Promise<{ id: string }> => {
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      const body = commentBody(args, 3);
      if (await localTarget(workspaceId)) cloudOnly("Commenting");
      return createComment(await authorizedRecord(), workspaceId, cardId, body);
    },
  );
  handle(workspaceChannels.commentEdit, devUrl, async (args): Promise<void> => {
    const [workspaceId, cardId, commentId] = requireId(args.slice(0, 3), 3);
    const body = commentBody(args, 4);
    if (await localTarget(workspaceId)) cloudOnly("Commenting");
    return editComment(
      await authorizedRecord(),
      workspaceId,
      cardId,
      commentId,
      body,
    );
  });
  handle(
    workspaceChannels.commentDelete,
    devUrl,
    async (args): Promise<void> => {
      const [workspaceId, cardId, commentId] = requireId(args, 3);
      if (await localTarget(workspaceId)) cloudOnly("Commenting");
      return deleteComment(
        await authorizedRecord(),
        workspaceId,
        cardId,
        commentId,
      );
    },
  );
  handle(
    workspaceChannels.subscribe,
    devUrl,
    async (args): Promise<boolean> => {
      if (args.length !== 3 || typeof args[2] !== "boolean")
        throw new Error("A card and a state are required");
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      if (await localTarget(workspaceId)) cloudOnly("Following a card");
      return setSubscription(
        await authorizedRecord(),
        workspaceId,
        cardId,
        args[2],
      );
    },
  );
  handle(workspaceChannels.favorite, devUrl, async (args): Promise<boolean> => {
    if (args.length !== 3 || typeof args[2] !== "boolean")
      throw new Error("A card and a state are required");
    const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
    if (await localTarget(workspaceId)) cloudOnly("Starring a card");
    return setFavorite(await authorizedRecord(), workspaceId, cardId, args[2]);
  });
  handle(
    workspaceChannels.attach,
    devUrl,
    async (args): Promise<BoardAttachment> => {
      if (args.length !== 3) throw new Error("A card and a file are required");
      const [workspaceId, cardId] = requireId(args.slice(0, 2), 2);
      if (await localTarget(workspaceId)) cloudOnly("Attaching files");
      return attachFile(
        await authorizedRecord(),
        workspaceId,
        cardId,
        parseAttachmentDraft(args[2]),
      );
    },
  );
  handle(workspaceChannels.detach, devUrl, async (args): Promise<void> => {
    const [workspaceId, cardId, attachmentId] = requireId(args, 3);
    if (await localTarget(workspaceId)) cloudOnly("Attaching files");
    return detachFile(
      await authorizedRecord(),
      workspaceId,
      cardId,
      attachmentId,
    );
  });
  handle(workspaceChannels.archive, devUrl, async (args): Promise<void> => {
    const [workspaceId, cardId] = requireId(args, 2);
    const local = await localTarget(workspaceId);
    if (local) return local.archive(cardId);
    return archiveCard(await authorizedRecord(), workspaceId, cardId);
  });
  handle(workspaceChannels.purge, devUrl, async (args) => {
    const [workspaceId, slug] = requireId(args, 2);
    const local = await localTarget(workspaceId);
    if (local) return local.purge(slug);
    return purgeIssues(await authorizedRecord(), workspaceId, slug);
  });
  handle(
    workspaceChannels.create,
    devUrl,
    async (args): Promise<BoardWrite> => {
      if (args.length !== 2)
        throw new Error("A workspace and a title are required");
      // FE-78/D7: the same 200-character, no-dot-segment check as every other
      // handler; this one used to take any non-blank string.
      const [workspaceId] = requireId(args.slice(0, 1), 1);
      const draft = parseDraft(args[1]);
      const local = await localTarget(workspaceId);
      if (local) return local.create(draft);
      return createCard(await authorizedRecord(), workspaceId, draft);
    },
  );
  handle(
    workspaceChannels.syncToCloud,
    devUrl,
    async (args): Promise<LocalSyncResult> => {
      const [localId] = requireId(args, 1);
      return syncToCloud(localId);
    },
  );
  handle(
    workspaceChannels.importPreview,
    devUrl,
    async (args): Promise<ImportPreview> => {
      const [workspaceId] = requireId(args, 1);
      if (await localTarget(workspaceId))
        cloudOnly("Importing a review folder");
      const { plan, folder } = await planFor(workspaceId);
      return {
        workspaceId,
        folder,
        cards: plan?.inventory.cards ?? 0,
        byColumn: plan?.inventory.byColumn ?? {},
        checklistItems: plan?.inventory.checklistItems ?? 0,
        withTaskId: plan?.inventory.withTaskId ?? 0,
        duplicateTaskIds: plan?.inventory.duplicateTaskIds ?? [],
        inferredCheckedAt: plan?.inventory.inferredCheckedAt ?? 0,
        groups: plan?.inventory.groups ?? 0,
        dropped: plan?.inventory.dropped ?? 0,
        attachments: plan?.inventory.attachments ?? 0,
        // Null, not 0: the local lifecycle history lives in the board's own
        // database, which this app does not open. Zero would claim there is
        // no history to leave behind.
        auditEventsLeftBehind: null,
        blocked: plan?.blocked ?? (folder ? null : NO_FOLDER),
        problems: plan?.inventory.problems ?? [],
      };
    },
  );
  handle(
    workspaceChannels.importRun,
    devUrl,
    async (args): Promise<ImportReport> => {
      const [workspaceId] = requireId(args, 1);
      if (await localTarget(workspaceId))
        cloudOnly("Importing a review folder");
      const record = await authorizedRecord();
      const { plan, folder } = await planFor(workspaceId);
      if (!plan || !folder)
        return { summary: {}, receipts: [], error: NO_FOLDER };
      if (plan.blocked)
        return { summary: {}, receipts: [], error: plan.blocked };
      if (!plan.records.length)
        return {
          summary: {},
          receipts: [],
          error: "That folder holds no review cards to send.",
        };

      // The lanes and categories go FIRST: a card cannot land in a lane the
      // board does not have yet.
      await putBoardConfig(record, workspaceId, plan.config);

      const receipts: ImportReport["receipts"] = [];
      const summary: Record<string, number> = {};
      let failure: string | null = null;
      for (let at = 0; at < plan.records.length; at += IMPORT_BATCH) {
        try {
          const batch = await importRecords(
            record,
            workspaceId,
            plan.records.slice(at, at + IMPORT_BATCH),
          );
          receipts.push(...batch.receipts);
          for (const [key, value] of Object.entries(batch.summary))
            summary[key] = (summary[key] ?? 0) + value;
        } catch (error) {
          // Stop, keep what landed, and SAY so. Nothing is lost by stopping:
          // records already accepted are keyed on their source ref, so the
          // next run skips them rather than duplicating them.
          failure =
            error instanceof Error ? error.message : "The import stopped.";
          break;
        }
      }

      const run = await writeMigrationRun(record, {
        workspaceId,
        at: new Date().toISOString(),
        summary,
        receipts,
        migratedAt: null,
      });
      return {
        summary: run.summary,
        receipts: run.receipts,
        migratedAt: null,
        error: failure,
      };
    },
  );
  handle(
    workspaceChannels.importSeal,
    devUrl,
    async (args): Promise<ImportReport> => {
      const [workspaceId] = requireId(args, 1);
      if (await localTarget(workspaceId))
        cloudOnly("Importing a review folder");
      const record = await authorizedRecord();
      const run = await readMigrationRun(record, workspaceId);
      if (!run)
        return {
          summary: {},
          receipts: [],
          error: "Send the cards first — there is no result to verify against.",
        };

      const sealed = await sealBoardMigration(
        record,
        workspaceId,
        sealableCount(run.summary),
        run.digest,
      );
      if (sealed.error)
        return {
          summary: run.summary,
          receipts: run.receipts,
          migratedAt: null,
          error: sealed.error,
        };
      await writeMigrationRun(record, {
        ...run,
        migratedAt: sealed.migratedAt,
      });
      return {
        summary: run.summary,
        receipts: run.receipts,
        migratedAt: sealed.migratedAt,
      };
    },
  );
  handle(
    workspaceChannels.folderState,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      const [slug] = requireId(args, 1);
      return folderState(slug);
    },
  );
  handle(
    workspaceChannels.folderChoose,
    devUrl,
    async (args): Promise<PickedFolder[]> => {
      if (args.length) throw new Error("This operation takes no arguments");
      // NOTE: Authorized like everything else here even though it writes
      // nothing: a signed-out window has no business opening a chooser, and a
      // folder picked before sign-in belongs to no account. Local mode may:
      // its folders are filed under the local board.
      await assertCanUse();
      return chooseFolders("Add source folders");
    },
  );
  handle(
    workspaceChannels.folderPick,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      const [slug] = requireId(args, 1);
      const record = await folderRecordFor(slug);
      const chosen = await pickFolder(`Choose the folder for ${slug}`);
      // Cancelling is not a failure and must not clear an existing link: the
      // honest answer is whatever was already true.
      if (!chosen) return folderState(slug);
      // Written even when the folder turns out to hold no cards. The user
      // chose it, and the screen has to be able to say "this folder has no
      // .agents" about the folder they are looking at; a link this app
      // refused to remember would read as the picker doing nothing.
      await writeFolders(record, slug, [chosen]);
      return {
        kind: "linked",
        summary: await readLocalFolder(chosen),
        others: [],
      };
    },
  );
  handle(
    workspaceChannels.folderList,
    devUrl,
    async (args): Promise<PickedFolder[]> => {
      const [slug] = requireId(args, 1);
      const record = await folderRecordFor(slug);
      return ((await readFolders(record))[slug] ?? []).map(registerFolder);
    },
  );
  handle(
    workspaceChannels.folderLink,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      if (args.length !== 2)
        throw new Error("A workspace and folders are required");
      const [slug] = requireId(args.slice(0, 1), 1);
      // Shape first, session second: a malformed list is the caller's bug and
      // must not be reported as "sign in".
      const paths = parseFolderIds(args[1]);
      await writeFolders(await folderRecordFor(slug), slug, paths);
      return folderState(slug);
    },
  );
  handle(
    workspaceChannels.folderForget,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      const [slug] = requireId(args, 1);
      await writeFolders(await folderRecordFor(slug), slug, null);
      return { kind: "none" };
    },
  );
  handle(
    workspaceChannels.folderReveal,
    devUrl,
    async (args): Promise<void> => {
      const [slug] = requireId(args, 1);
      const path = (await readFolders(await folderRecordFor(slug)))[slug]?.[0];
      // NOTE: The path comes from this app's own file, never from the
      // renderer. A channel that opened a path it was handed is a channel
      // that opens anything the user can read.
      if (!path) throw new Error("No folder is linked to this workspace.");
      await revealFolder(path);
    },
  );

  // The offline MCP server and the Stop hook write the local board from other
  // processes. Polled only while a window is open to show it.
  watchLocalStore(
    (workspaceIds) => broadcast(workspaceChannels.localChanged, workspaceIds),
    { active: () => BrowserWindow.getAllWindows().length > 0 },
  );
}
