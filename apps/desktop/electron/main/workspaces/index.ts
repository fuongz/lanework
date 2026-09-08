import { can } from "../../../shared/policy";
import {
  type BoardView,
  type BoardWrite,
  type ImportPreview,
  type ImportReport,
  type LocalFolderState,
  type WorkspaceSnapshot,
  workspaceChannels,
} from "../../../shared/workspaces";
import { currentSession } from "../auth";
import { resolveApi } from "../auth/client";
import { type MachineRecord, readRecord } from "../auth/store";
import { handle } from "../ipc";
import {
  createCard,
  createWorkspace,
  fetchBoardConfig,
  fetchCards,
  fetchWorkspaces,
  importRecords,
  moveCard,
  putBoardConfig,
  sealBoardMigration,
  toggleChecklistItem,
} from "./client";
import { pickFolder, revealFolder } from "./folder-chooser";
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
  writeFolder,
  writeMigrationRun,
} from "./store";

async function authorizedRecord(): Promise<MachineRecord> {
  const session = await currentSession();
  if (
    !can(session.principal, "app:use") ||
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

/**
 * The workspace list, and which one is selected.
 *
 * ⚠️ Selection is by CLOUD WORKSPACE ID. A slug is a display key a rename can
 * move, and every board call is `/v1/boards/:workspaceId/…`; keying the
 * selection on the slug is how a renamed project silently becomes "no workspace
 * selected". A `v1` file that still names a slug is resolved once and rewritten.
 */
async function load(id?: string): Promise<WorkspaceSnapshot> {
  const record = await authorizedRecord();
  const workspaces = await fetchWorkspaces(record);
  const saved = await readActive(record);
  await assertSameSession(record);

  // ⚠️ A selector is matched against the id AND the slug. The renderer sends
  // `id ?? slug`, and against a service that predates the id field every id is
  // null — matching on the id alone made every Open button answer "this
  // workspace is no longer available", which is the one sentence that is
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
  // Write when the caller chose one, when an older shape was just resolved, or
  // when what was saved no longer exists.
  if (id !== undefined || saved?.by === "slug" || (saved !== null && !active))
    await writeActive(record, {
      id: active?.id ?? null,
      slug: active?.slug ?? null,
    });
  await assertSameSession(record);
  return { workspaces, active };
}

/**
 * A board, or the last good copy of it with `stale: true`.
 *
 * ⚠️ It never answers with an empty board on failure. That is the whole reason
 * the cache exists: a board that reads as empty invites somebody to start typing
 * a card that already exists, and no error dialog undoes that.
 */
async function board(workspaceId: string): Promise<BoardView> {
  const record = await authorizedRecord();
  try {
    const [config, cards] = await Promise.all([
      fetchBoardConfig(record, workspaceId),
      fetchCards(record, workspaceId),
    ]);
    await assertSameSession(record);
    const view: BoardView = {
      workspaceId,
      columns: config.columns,
      categories: config.categories,
      cards,
      migrated: Boolean(config.migratedAt),
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
    await writeBoardCache(record, workspaceId, view);
    return view;
  } catch (error) {
    const cached = await readBoardCache(record, workspaceId);
    if (cached) return cached;
    throw error;
  }
}

/**
 * Whether this workspace has a folder on this machine, and what is in it.
 *
 * ⚠️ A linked folder that has since moved is `missing`, not `none`. Answering
 * "no folder linked" would invite the user to link it again and be told nothing
 * about why the one they chose stopped working.
 */
async function folderState(slug: string): Promise<LocalFolderState> {
  const record = await authorizedRecord();
  const path = (await readFolders(record))[slug];
  if (!path) return { kind: "none" };
  // `readLocalFolder` can describe a folder that is not a project; a folder
  // that is not THERE is the one case it cannot, so it is checked first.
  if (!(await folderExists(path))) return { kind: "missing", path };
  return { kind: "linked", summary: await readLocalFolder(path) };
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
  // ⚠️ Matched on the id OR the slug, because the link is keyed by slug and the
  // caller addresses a board by id. Looking up one from the other here is what
  // keeps the renderer from having to know both.
  const workspace = workspaces.find(
    (entry) => entry.id === workspaceId || entry.slug === workspaceId,
  );
  const folder = workspace
    ? ((await readFolders(record))[workspace.slug] ?? null)
    : null;
  if (!folder) return { plan: null, folder: null };
  return { plan: await planMigration(folder), folder };
}

/**
 * How many cards the board should hold if the last run is what it says.
 *
 * ⚠️ Every record the run ACCOUNTED FOR, not just the new ones: a re-run
 * reports a card that is already there as `skipped`, so counting `imported`
 * alone makes the second seal of the same project fail by exactly the number of
 * cards that did land. `conflict` and `failed` are excluded for the mirror
 * reason — those are the records the board does not hold.
 */
function sealableCount(summary: Record<string, number>): number {
  return (
    (summary.imported ?? 0) + (summary.updated ?? 0) + (summary.skipped ?? 0)
  );
}

function requireId(args: unknown[], count: number): string[] {
  if (
    args.length !== count ||
    !args.every(
      (arg) => typeof arg === "string" && arg.trim() && arg.length <= 200,
    )
  )
    throw new Error("A valid workspace and card are required");
  return args as string[];
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
  handle(
    workspaceChannels.createWorkspace,
    devUrl,
    async (args): Promise<WorkspaceSnapshot> => {
      if (
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        !args[0].trim() ||
        args[0].length > 200
      )
        throw new Error("A project name is required");
      const name = args[0].trim();
      const created = await createWorkspace(await authorizedRecord(), {
        slug: slugify(name),
        name,
      });
      // ⚠️ Created AND opened, in one act. A project that appeared in the list
      // and left the user to click "Open" would be two steps for one intention,
      // and `load` is what writes the selection down — so this also survives a
      // relaunch, which is the whole promise of the picker.
      return load(created.id);
    },
  );
  handle(workspaceChannels.board, devUrl, (args) => {
    const [workspaceId] = requireId(args, 1);
    return board(workspaceId);
  });
  handle(workspaceChannels.move, devUrl, async (args): Promise<BoardWrite> => {
    const [workspaceId, cardId, columnKey] = requireId(args, 3);
    return moveCard(await authorizedRecord(), workspaceId, cardId, columnKey);
  });
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
    workspaceChannels.create,
    devUrl,
    async (args): Promise<BoardWrite> => {
      if (
        args.length !== 2 ||
        typeof args[0] !== "string" ||
        typeof args[1] !== "string" ||
        !args[1].trim() ||
        args[1].length > 200
      )
        throw new Error("A workspace and a title are required");
      return createCard(await authorizedRecord(), args[0], args[1].trim());
    },
  );
  handle(
    workspaceChannels.importPreview,
    devUrl,
    async (args): Promise<ImportPreview> => {
      const [workspaceId] = requireId(args, 1);
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
        // ⚠️ Null, not 0: the local lifecycle history lives in the board's own
        // database, which this app does not open. Zero would claim there is no
        // history to leave behind.
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
          // ⚠️ Stop, keep what landed, and SAY so. Nothing is lost by stopping:
          // records already accepted are keyed on their source ref, so the next
          // run skips them rather than duplicating them.
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
    workspaceChannels.folderPick,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      const [slug] = requireId(args, 1);
      const record = await authorizedRecord();
      const chosen = await pickFolder(`Choose the folder for ${slug}`);
      // Cancelling is not a failure and must not clear an existing link: the
      // honest answer is whatever was already true.
      if (!chosen) return folderState(slug);
      // ⚠️ Written even when the folder turns out to hold no cards. The user
      // chose it, and the screen has to be able to say "this folder has no
      // .agents" about the folder they are looking at — a link this app
      // silently refused to remember would read as the picker doing nothing.
      await writeFolder(record, slug, chosen);
      return { kind: "linked", summary: await readLocalFolder(chosen) };
    },
  );
  handle(
    workspaceChannels.folderForget,
    devUrl,
    async (args): Promise<LocalFolderState> => {
      const [slug] = requireId(args, 1);
      await writeFolder(await authorizedRecord(), slug, null);
      return { kind: "none" };
    },
  );
  handle(
    workspaceChannels.folderReveal,
    devUrl,
    async (args): Promise<void> => {
      const [slug] = requireId(args, 1);
      const path = (await readFolders(await authorizedRecord()))[slug];
      // ⚠️ The path comes from this app's own file, never from the renderer. A
      // channel that opened a path it was handed is a channel that opens
      // anything the user can read.
      if (!path) throw new Error("No folder is linked to this workspace.");
      await revealFolder(path);
    },
  );
}
