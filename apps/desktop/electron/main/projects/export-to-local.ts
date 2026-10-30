// "Export to local": copy a cloud board into this machine's local store
// (FE-110). The way back from "Sync to cloud".
//
// A COPY (FE-110/D1). The cloud board is only read, never written. The local
// board is a new one with no link back to it (D3), so exporting twice makes
// two local boards, and syncing a copy to the cloud later makes a second cloud
// project rather than merging into this one.
//
// What travels: the lanes, categories (with their task-id format), labels and
// tag cap; every live card with its task id (D2), lane and order, parent,
// checklist ticks with when they were ticked, streams and the newest
// checkpoint (D4). Archived cards stay behind (D5). Comments, activity and
// assignees have nowhere to go on a local board.
//
// NOTE: Everything is read first and written after, in ONE store transaction.
// A failed read leaves the store untouched, and a write the store refuses
// rolls the whole board back, so there is never a local board with half the
// cards.
//
// Electron-free: `tests/` and `bun test` drive it against a stub plane.
import type {
  CheckpointRequest,
  Placement,
  WorkItemType,
} from "@lanework/protocol";
import type {
  BoardCard,
  BoardChecklistItem,
  BoardStream,
  CardCheckpoint,
} from "../../../shared/projects";
import type { LocalProject, LocalStore } from "../../local-store";
import type { MachineRecord } from "../auth/store";
import {
  fetchBoardSettings,
  fetchCard,
  fetchCards,
  fetchCheckpoint,
} from "./client";
import { parseTaskSeq } from "./review-import";

/** Card reads in flight at once: one board read, not a burst of hundreds. */
const READ_AHEAD = 6;

/** The cloud project to copy. */
export interface ExportSource {
  id: string;
  slug: string;
  name: string;
}

export interface ExportOutcome {
  /** The new local board. */
  project: LocalProject;
  /** Cards it holds. */
  cards: number;
}

interface CloudCard {
  card: BoardCard;
  checkpoint: CardCheckpoint | null;
}

/** A whole cloud board, read and held in memory until it is written. */
export interface CloudBoardCopy {
  config: Awaited<ReturnType<typeof fetchBoardSettings>>;
  cards: CloudCard[];
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function inPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Read everything the copy needs from the cloud board `cloudId`.
 *
 * @throws On any failed read; nothing has been written yet.
 */
export async function readCloudBoard(
  record: MachineRecord,
  cloudId: string,
): Promise<CloudBoardCopy> {
  const config = await fetchBoardSettings(record, cloudId);
  const closed = new Set(
    config.columns
      .filter((column) => column.role === "done" || column.role === "archive")
      .map((column) => column.key),
  );
  const listed = (await fetchCards(record, cloudId)).filter(
    (card) => !card.archivedAt,
  );
  const cards = await inPool(listed, READ_AHEAD, async (entry) => {
    // A list read carries no checklist; the card's own read does.
    const card = await fetchCard(record, cloudId, entry.id);
    // A finished card has no checkpoints, and the store refuses one there.
    const checkpoint = closed.has(card.columnKey)
      ? null
      : await fetchCheckpoint(record, cloudId, card.id);
    return { card, checkpoint };
  });
  return { config, cards };
}

function checklistOf(items: BoardChecklistItem[]) {
  return items.map((item) => ({
    key: item.key,
    section: item.section,
    text: item.text,
    checked: item.checked,
    checkedAt: item.checked ? item.checkedAt : null,
    note: item.note,
    group: item.group,
    stream: item.stream ?? null,
  }));
}

function streamsOf(streams: BoardStream[]) {
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
 * A checkpoint as the store takes one.
 *
 * NOTE: The store stamps its own `createdAt`, so a carried checkpoint reads as
 * written at export time. Its agent is kept; its content is the cloud's.
 */
function checkpointOf(checkpoint: CardCheckpoint): CheckpointRequest {
  return {
    summary: checkpoint.summary,
    request: checkpoint.request,
    nextStep: checkpoint.nextStep,
    files: checkpoint.files,
    host: checkpoint.host,
    git: checkpoint.git,
  };
}

/** Parents first: depth 0 (top level), then their children, and so on. */
function byDepth(cards: CloudCard[]): CloudCard[][] {
  const parentOf = new Map(
    cards.map(({ card }) => [card.id, card.parentId] as const),
  );
  const depthOf = (id: string): number => {
    let depth = 0;
    for (
      let cursor = parentOf.get(id) ?? null;
      cursor && parentOf.has(cursor) && depth < 100;
      cursor = parentOf.get(cursor) ?? null
    )
      depth += 1;
    return depth;
  };
  const levels: CloudCard[][] = [];
  for (const entry of cards) {
    const depth = depthOf(entry.card.id);
    const level = levels[depth] ?? [];
    level.push(entry);
    levels[depth] = level;
  }
  return levels.filter(Boolean);
}

/**
 * Where a card goes in its lane: beside the nearest lane-mate already written.
 *
 * Parents are written before their children, so a lane does not fill top to
 * bottom; anchoring on a neighbour keeps the cloud's order anyway.
 */
function placementFor(
  lane: CloudCard[],
  index: number,
  localIds: Map<string, string>,
): Placement | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    const id = localIds.get((lane[at] as CloudCard).card.id);
    if (id) return { after: id };
  }
  for (let at = index + 1; at < lane.length; at += 1) {
    const id = localIds.get((lane[at] as CloudCard).card.id);
    if (id) return { before: id };
  }
  return null;
}

/**
 * Write `copy` as a new local board named after `source`.
 *
 * The slug is the cloud one, or `-2`, `-3`, … when this machine already has
 * it.
 *
 * @throws When the store refuses any of it, with the store as it was.
 */
export function writeLocalCopy(
  store: LocalStore,
  source: ExportSource,
  copy: CloudBoardCopy,
): ExportOutcome {
  const { config } = copy;
  return store.transaction(() => {
    const project = store.createProject({
      name: source.name,
      slug: source.slug,
      config: {
        columns: config.columns,
        categories: config.categories,
        labels: config.labels,
        ...(config.tags ? { tags: config.tags } : {}),
      },
    });
    const categories = new Map(
      config.categories.map((category) => [category.key, category]),
    );
    const position = new Map(
      config.columns.map((column) => [column.key, column.position]),
    );
    // NOTE: A plain comparison, not `localeCompare`: a rank is a fractional
    // index, ordered by code unit, and a locale would reorder it.
    const ordered = [...copy.cards].sort(
      (a, b) =>
        (position.get(a.card.columnKey) ?? 0) -
          (position.get(b.card.columnKey) ?? 0) ||
        (a.card.rank < b.card.rank ? -1 : a.card.rank > b.card.rank ? 1 : 0) ||
        (a.card.id < b.card.id ? -1 : 1),
    );
    const lanes = new Map<string, CloudCard[]>();
    for (const entry of ordered) {
      const lane = lanes.get(entry.card.columnKey) ?? [];
      lane.push(entry);
      lanes.set(entry.card.columnKey, lane);
    }

    const localIds = new Map<string, string>();
    for (const level of byDepth(ordered)) {
      for (const entry of level) {
        const { card, checkpoint } = entry;
        const category = card.categoryKey
          ? categories.get(card.categoryKey)
          : undefined;
        // A task id travels only with a sequence its category can read.
        // Without one the store mints the next id, as the cloud would.
        const taskSeq =
          card.taskId && category ? parseTaskSeq(card.taskId, category) : null;
        const lane = lanes.get(card.columnKey) ?? [];
        const created = store.createWorkItem(project.id, {
          title: card.title,
          // Free text on the wire; the store checks it against the types it knows.
          type: card.type as WorkItemType,
          body: card.body,
          columnKey: card.columnKey,
          parentId: card.parentId
            ? (localIds.get(card.parentId) ?? null)
            : null,
          priority: card.priority,
          categoryKey: category ? category.key : null,
          tags: card.tags,
          streams: streamsOf(card.streams ?? []),
          placement: placementFor(lane, lane.indexOf(entry), localIds),
          restore: {
            taskId: taskSeq ? card.taskId : null,
            taskSeq,
            createdAt: card.createdAt,
            updatedAt: card.updatedAt,
            checklist: checklistOf(card.checklist ?? []),
          },
        });
        localIds.set(card.id, created.id);
        if (checkpoint)
          store.addCheckpoint(created.id, checkpointOf(checkpoint), {
            agent: checkpoint.agent,
            project: project.id,
          });
      }
    }
    return {
      project: store.getProject(project.id) ?? project,
      cards: localIds.size,
    };
  });
}

/** Read the cloud board, then write its local copy. */
export async function exportCloudProject(
  store: LocalStore,
  record: MachineRecord,
  source: ExportSource,
): Promise<ExportOutcome> {
  const copy = await readCloudBoard(record, source.id);
  return writeLocalCopy(store, source, copy);
}
