// "Sync to cloud" (FE-52/D7a): MOVE a local board to the signed-in account.
//
// The upload is the migration path the cloud already has — `PUT /config`, then
// `POST /import` in batches, then `POST /migrated` to seal — with the records
// built from the local store instead of `.agents/reviews/`. Task ids, checklist
// ticks (with when they were ticked), lanes, streams and parent links all go
// across; only once the cloud has SEALED the board is the local copy marked as
// moved (`synced_at`) and turned read-only.
//
// ⚠️ Nothing local is changed until the very end, and nothing local is ever
// deleted. A failure anywhere before the seal leaves every card exactly where
// it was, still writable; the one local write before then is the cloud id of
// the board being filled, so the next run continues INTO that board instead of
// creating a second one. The cloud keys every record on `(source.kind,
// source.ref)` — the local card's uuid — so a re-run skips what already landed.
//
// ⚠️ Electron-free: `tests/` and `bun test` drive it against a stub plane.
import { createHash } from "node:crypto";
import type { CardDetail, ChecklistItem, Stream } from "@lanework/protocol";
import type { LocalStore, LocalWorkspace } from "../../local-store";
import type { MachineRecord } from "../auth/store";
import {
  createWorkspace,
  fetchBoardConfig,
  importRecords,
  putBoardConfig,
  sealBoardMigration,
} from "./client";
import { IMPORT_BATCH, parseTaskSeq } from "./review-import";

/** The `source.kind` a card moved from this machine's local board carries. */
const LOCAL_SOURCE_KIND = "lanework-local";

export interface SyncRecord {
  title: string;
  body: string;
  type: string;
  columnKey: string;
  categoryKey: string | null;
  priority: string | null;
  tags: string[];
  streams: {
    key: string;
    title: string;
    goal: string;
    role: string;
    owns: string[];
    reads: string[];
    depends_on: string[];
    isolation: string;
  }[];
  parentId?: string;
  metadata: Record<string, unknown>;
  source: { kind: string; ref: string; checksum: string };
  restore: {
    taskId: string | null;
    taskSeq: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    checklist: {
      key: string;
      section: string;
      text: string;
      checked?: boolean;
      checkedAt?: string;
      note?: string;
      group?: string;
      stream?: string;
    }[];
  };
}

/** One card to send, with the local parent it hangs under. */
interface PlannedCard {
  localId: string;
  parentLocalId: string | null;
  record: SyncRecord;
}

interface SyncOutcome {
  localId: string;
  cloudId: string;
  /** The cloud project's slug — the key this machine's folder link moves to. */
  cloudSlug: string;
  /** Cards the cloud board now holds from this one. */
  cards: number;
}

const checksum = (detail: CardDetail) =>
  createHash("sha1")
    .update(`${detail.id}:${detail.revision}:${detail.updatedAt}`)
    .digest("hex")
    .slice(0, 12);

function checklistOf(items: ChecklistItem[], fallbackAt: string) {
  return items.map((item) => ({
    key: item.key,
    section: item.section,
    text: item.text,
    // ⚠️ The import REQUIRES `checkedAt` with `checked: true` and refuses it
    // otherwise. A tick the store holds without a moment (written before it
    // stamped one) gets the card's own last change, the latest moment the
    // store can vouch for.
    ...(item.checked
      ? { checked: true, checkedAt: item.checkedAt ?? fallbackAt }
      : {}),
    ...(item.note ? { note: item.note } : {}),
    ...(item.group ? { group: item.group } : {}),
    ...(item.stream ? { stream: item.stream } : {}),
  }));
}

function streamsOf(streams: Stream[]): SyncRecord["streams"] {
  return [...streams]
    .sort((a, b) => a.position - b.position)
    .map((stream) => ({
      key: stream.key,
      title: stream.title,
      goal: stream.goal,
      role: stream.role,
      owns: stream.owns,
      reads: stream.reads,
      depends_on: stream.dependsOn,
      isolation: stream.isolation,
    }));
}

/**
 * The records a move sends, parents before children, in lane order.
 *
 * ⚠️ Sent in `(lane, rank)` order WITHOUT a rank, like the folder migration:
 * the cloud appends each record to the bottom of its lane, so arriving in
 * order IS the order — and a local rank string is not the cloud's fractional
 * index, so sending it would be a second copy of that code that has to agree
 * with the first forever.
 *
 * ⚠️ A task id travels only with its sequence AND a category, as the import
 * demands; one whose category was cleared after it was minted goes without
 * it, and the cloud mints the card a new one when it is next categorized.
 */
function planSync(store: LocalStore, workspace: LocalWorkspace): PlannedCard[] {
  const categories = new Map(
    workspace.config.categories.map((category) => [category.key, category]),
  );
  const columns = new Map(
    workspace.config.columns.map((column, index) => [
      column.key,
      column.position ?? index,
    ]),
  );
  const cards = store.listWorkItems(workspace.id);
  const live = new Set(cards.map((card) => card.id));
  const ordered = [...cards].sort(
    (a, b) =>
      (columns.get(a.columnKey) ?? 0) - (columns.get(b.columnKey) ?? 0) ||
      a.rank.localeCompare(b.rank) ||
      a.id.localeCompare(b.id),
  );
  return ordered.flatMap((card): PlannedCard[] => {
    const detail = store.getWorkItem(card.id, { workspace: workspace.id });
    if (!detail) return [];
    const category = detail.categoryKey
      ? categories.get(detail.categoryKey)
      : undefined;
    const taskSeq =
      detail.taskId && category
        ? parseTaskSeq(detail.taskId, {
            prefix: category.prefix,
            format:
              (category as { format?: string }).format ?? "{prefix}-{seq}",
          })
        : null;
    const taskId = taskSeq ? detail.taskId : null;
    const at = detail.updatedAt ?? detail.createdAt ?? new Date().toISOString();
    return [
      {
        localId: detail.id,
        // A parent that is not on the board any more is no parent at all.
        parentLocalId:
          detail.parentId && live.has(detail.parentId) ? detail.parentId : null,
        record: {
          title: detail.title,
          body: detail.body ?? "",
          type: detail.type,
          columnKey: detail.columnKey,
          categoryKey: detail.categoryKey,
          priority: detail.priority,
          tags: detail.tags,
          streams: streamsOf(detail.streams ?? []),
          metadata: {
            import: {
              tool: "lanework-desktop",
              from: "local-board",
              localWorkspaceId: workspace.id,
              localId: detail.id,
            },
          },
          source: {
            kind: LOCAL_SOURCE_KIND,
            ref: detail.id,
            checksum: checksum(detail),
          },
          restore: {
            taskId,
            taskSeq,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            checklist: checklistOf(detail.checklist, at),
          },
        },
      },
    ];
  });
}

/** Parents first: depth 0 (top-level), then their children, and so on. */
function byDepth(cards: PlannedCard[]): PlannedCard[][] {
  const parentOf = new Map(
    cards.map((card) => [card.localId, card.parentLocalId]),
  );
  const depthOf = (id: string): number => {
    let depth = 0;
    for (
      let cursor = parentOf.get(id) ?? null;
      cursor && depth < 100;
      cursor = parentOf.get(cursor) ?? null
    )
      depth += 1;
    return depth;
  };
  const levels: PlannedCard[][] = [];
  for (const card of cards) {
    const depth = depthOf(card.localId);
    const level = levels[depth] ?? [];
    level.push(card);
    levels[depth] = level;
  }
  return levels.filter(Boolean);
}

/** The board config the cloud board is created with: the local one, as is. */
function configOf(workspace: LocalWorkspace) {
  return {
    columns: workspace.config.columns.map((column, position) => ({
      ...column,
      position: column.position ?? position,
    })),
    categories: workspace.config.categories.map((category, position) => ({
      ...category,
      position: (category as { position?: number }).position ?? position,
    })),
    labels: workspace.config.labels,
    tags: workspace.config.tags,
  };
}

/**
 * The cloud project the board moves into: the one a stopped run already made,
 * or a new one under the local board's slug (`-2`, `-3`, … when the account
 * already has that slug).
 */
async function cloudTarget(
  store: LocalStore,
  record: MachineRecord,
  workspace: LocalWorkspace,
  path: string | null,
): Promise<{ id: string; slug: string }> {
  if (workspace.cloudId) return { id: workspace.cloudId, slug: workspace.slug };
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const slug =
      attempt === 1 ? workspace.slug : `${workspace.slug}-${attempt}`;
    try {
      const created = await createWorkspace(record, {
        slug,
        name: workspace.name,
        ...(path ? { path } : {}),
      });
      // ⚠️ Written down AT ONCE, before a single card is sent. This is the
      // one local write before the seal, and it is what makes a stopped run
      // resumable: the next run continues into this board instead of making a
      // second project with half the cards in each.
      store.updateWorkspace(workspace.id, { cloudId: created.id });
      return { id: created.id, slug: created.slug };
    } catch (error) {
      if (
        error instanceof Error &&
        /already uses the key/.test(error.message) &&
        attempt < 6
      )
        continue;
      throw error;
    }
  }
  throw new Error("Could not find a free project key on your account.");
}

type Receipt = {
  ref: string;
  status: string;
  itemId?: string;
  taskId?: string | null;
  error?: string;
};

const stopped = (reason: string) =>
  new Error(
    `${reason} Nothing on this machine was changed — run Sync to cloud again to continue where it stopped.`,
  );

/**
 * Move `localId` to the account `record` belongs to.
 *
 * Throws, with the local board untouched, on any failure before the seal.
 */
export async function syncLocalWorkspace(
  store: LocalStore,
  record: MachineRecord,
  localId: string,
  options: { path?: string | null } = {},
): Promise<SyncOutcome> {
  const workspace = store.getWorkspace(localId);
  if (!workspace || workspace.id !== localId)
    throw new Error("That board is not on this machine.");
  if (workspace.syncedAt && workspace.cloudId)
    throw new Error("This board was already moved to the cloud.");

  const target = await cloudTarget(
    store,
    record,
    workspace,
    options.path ?? null,
  );

  // A run that stopped AFTER the seal (while marking the local copy) has
  // nothing left to send: the cloud owns the board already.
  const sealedBefore = workspace.cloudId
    ? await fetchBoardConfig(record, target.id)
        .then((config) => config.migratedAt)
        .catch(() => null)
    : null;

  const planned = planSync(store, workspace);
  const cloudIds = new Map<string, string>();
  let accounted = 0;

  if (!sealedBefore) {
    try {
      await putBoardConfig(record, target.id, configOf(workspace));
    } catch (error) {
      throw stopped(error instanceof Error ? error.message : String(error));
    }

    const receipts: Receipt[] = [];
    for (const level of byDepth(planned)) {
      for (let at = 0; at < level.length; at += IMPORT_BATCH) {
        const batch = level
          .slice(at, at + IMPORT_BATCH)
          .map(({ record: body, parentLocalId }) => {
            const parentId = parentLocalId
              ? cloudIds.get(parentLocalId)
              : undefined;
            return parentId ? { ...body, parentId } : body;
          });
        let answer: Awaited<ReturnType<typeof importRecords>>;
        try {
          answer = await importRecords(record, target.id, batch);
        } catch (error) {
          throw stopped(error instanceof Error ? error.message : String(error));
        }
        for (const receipt of answer.receipts as Receipt[]) {
          receipts.push(receipt);
          if (receipt.itemId) cloudIds.set(receipt.ref, receipt.itemId);
        }
      }
    }

    // ⚠️ A conflict or a failure is a card the cloud board does NOT hold, and
    // sealing over it would mark the local copy — the only one left with that
    // card — read-only. Stop and name them instead.
    const refused = receipts.filter(
      (receipt) => receipt.status === "conflict" || receipt.status === "failed",
    );
    if (refused.length)
      throw stopped(
        `The cloud refused ${refused.length} card(s): ${refused
          .slice(0, 3)
          .map((receipt) => receipt.error ?? receipt.status)
          .join("; ")}.`,
      );
    accounted = receipts.filter((receipt) =>
      ["imported", "updated", "skipped"].includes(receipt.status),
    ).length;

    const manifest = createHash("sha256")
      .update(JSON.stringify(receipts))
      .digest("hex");
    const sealed = await sealBoardMigration(
      record,
      target.id,
      accounted,
      manifest,
    );
    if (sealed.error)
      throw stopped(`The cloud did not seal the board: ${sealed.error}.`);
  } else {
    accounted = planned.length;
  }

  // ── Sealed: the cloud owns these cards. Mark the local copy as moved. ──────
  for (const card of planned) {
    const cloudId = cloudIds.get(card.localId);
    if (!cloudId) continue;
    try {
      store.updateWorkItem(
        card.localId,
        { cloudId },
        { workspace: workspace.id },
      );
    } catch {
      // A card's pointer is a convenience; the board's is what matters.
    }
  }
  store.updateWorkspace(workspace.id, {
    cloudId: target.id,
    syncedAt: new Date().toISOString(),
  });

  return {
    localId,
    cloudId: target.id,
    cloudSlug: target.slug,
    cards: accounted,
  };
}
