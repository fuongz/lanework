// The board IPCs, served from the local SQLite store instead of the control
// plane (FE-52). `index.ts` routes a call here when its workspace id names a
// LOCAL board — in local mode, and signed in too (D6a: local boards stay in
// the list beside the cloud ones).
//
// ⚠️ Electron-free and network-free. Nothing in this file may import
// `fetch`-calling code: V2 is "local mode sends no request to the control
// plane", and the cheapest way to keep that true is that the local path has
// nowhere to send one from. It reuses `client.ts`'s PARSERS only — the same
// `BoardCard` shape the cloud path answers with, so the renderer cannot tell
// the two apart except by `Workspace.origin`.
import { existsSync } from "node:fs";
import type { Card, CardDetail, LatestCheckpoint } from "@lanework/protocol";
import {
  type BoardCard,
  type BoardCardDraft,
  type BoardCardPatch,
  type BoardChanges,
  type BoardChecklistDraft,
  type BoardGroupPage,
  type BoardPlacement,
  type BoardQuery,
  type BoardStats,
  type BoardView,
  type BoardWrite,
  boardQueryKey,
  type CardCheckpoint,
  DEFAULT_BOARD_QUERY,
  matchesSearch,
  normalizeTag,
  type Workspace,
} from "../../../shared/workspaces";
import {
  type LocalStore,
  LocalStoreError,
  type LocalWorkspace,
  localStorePath,
  openLocalStore,
  type WorkItemListQuery,
} from "../../local-store";
import { groupSpecs, parseBoardConfig, parseCard } from "./client";

// ── The store ────────────────────────────────────────────────────────────────

let opened: LocalStore | null = null;

/**
 * The one connection this process holds, opened on first use.
 *
 * ⚠️ `create: false` (every read) does NOT create the file. A signed-in user
 * who never chose local mode must not grow a `data.sqlite` because the app
 * checked whether some board id was a local one — so "no file" answers "no
 * local boards" without opening anything.
 */
export function localStore(
  options: { create?: boolean } = {},
): LocalStore | null {
  if (opened) return opened;
  if (!options.create && !existsSync(localStorePath())) return null;
  opened = openLocalStore();
  return opened;
}

/** Close the connection (app quit, tests switching homes). */
export function closeLocalStore(): void {
  opened?.close();
  opened = null;
  seen = null;
}

/** The store, created if need be — for the writes that start a local board. */
export function requireLocalStore(): LocalStore {
  const store = localStore({ create: true });
  if (!store) throw new Error("Could not open the board on this machine.");
  return store;
}

// ── Workspaces ───────────────────────────────────────────────────────────────

/** A local board as the workspace list carries it. */
export function toWorkspace(
  workspace: LocalWorkspace,
  path: string | null = null,
): Workspace {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    path,
    baseBranch: null,
    origin: "local",
    // ⚠️ Moved only once the upload was SEALED. A cloud id with no `syncedAt`
    // is a sync that stopped half way: the local board is still the real one.
    movedTo: workspace.syncedAt ? workspace.cloudId : null,
  };
}

export function listLocalWorkspaces(): LocalWorkspace[] {
  return localStore()?.listWorkspaces() ?? [];
}

/**
 * The local board `key` names — by id always, by slug only when asked.
 *
 * ⚠️ Board calls address a workspace by id, and a local id is a UUIDv7 no
 * cloud board shares. A SLUG can be shared — a board and the cloud copy it was
 * moved to usually have the same one — so the slug match is opt-in, for the
 * callers that have nothing else (the folder links, keyed by slug).
 */
export function findLocalWorkspace(
  key: string,
  options: { bySlug?: boolean } = {},
): LocalWorkspace | null {
  const store = localStore();
  if (!store) return null;
  const found = store.getWorkspace(key);
  if (!found) return null;
  if (found.id === key) return found;
  return options.bySlug ? found : null;
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/** FE-52/D10: features that live on the control plane only. */
export const CLOUD_ONLY_SUFFIX =
  "is only on cloud boards. Sync this board to the cloud to use it.";

/**
 * FE-52/D10: refuse a cloud-only feature on a local board. `what` is a noun
 * phrase read as one thing — "Commenting", "Agent presence".
 */
export function cloudOnly(what: string): never {
  throw new Error(`${what} ${CLOUD_ONLY_SUFFIX}`);
}

export const MOVED_MESSAGE =
  "This board moved to the cloud. Open the cloud copy to change it.";

// ── Change watch ─────────────────────────────────────────────────────────────

/** The `dataVersion` the renderer is known to have seen. */
let seen: number | null = null;

/**
 * Run `write`, and if it was the ONLY write since the last look, move the
 * watch past it: the window that made it already has the answer, and a
 * refresh event for its own edit would make it read the board twice.
 */
function noting<T>(store: LocalStore, write: () => T): T {
  const before = store.dataVersion();
  const result = write();
  const after = store.dataVersion();
  if (seen === before && after === before + 1) seen = after;
  return result;
}

/** Live local boards with a card changed after `since`. */
function changedWorkspaces(store: LocalStore, since: number): string[] {
  const ids: string[] = [];
  for (const workspace of store.listWorkspaces())
    if (store.listChanges(workspace.id, since).items.length)
      ids.push(workspace.id);
  return ids;
}

/**
 * Poll the store's `dataVersion` and call `onChange` when it moves — the
 * offline MCP server and the Stop hook write the same file from other
 * processes, and SQLite tells no one.
 *
 * ⚠️ The ids are the boards with a CARD that changed. A write that touched no
 * card (a board created, renamed or deleted) reports `[]`: "re-read every
 * local thing", which is what the renderer does with an empty list.
 */
export function watchLocalStore(
  onChange: (workspaceIds: string[]) => void,
  options: { intervalMs?: number; active?: () => boolean } = {},
): () => void {
  const timer = setInterval(() => {
    if (options.active && !options.active()) return;
    try {
      const store = localStore();
      if (!store) return;
      const version = store.dataVersion();
      if (seen === null) {
        seen = version;
        return;
      }
      if (version === seen) return;
      const since = seen;
      seen = version;
      onChange(changedWorkspaces(store, since));
    } catch {
      // A busy or vanished file is a missed tick; the next one looks again.
    }
  }, options.intervalMs ?? 750);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── One board ────────────────────────────────────────────────────────────────

function droppedTags(requested: string[] | undefined, kept: string[]) {
  if (!requested?.length) return [];
  const landed = new Set(kept.map(normalizeTag));
  const seenTags = new Set<string>();
  return requested.filter((tag) => {
    const key = normalizeTag(tag);
    if (!key || landed.has(key) || seenTags.has(key)) return false;
    seenTags.add(key);
    return true;
  });
}

const cardOf = (card: Card | CardDetail): BoardCard => {
  const parsed = parseCard(card);
  if (!parsed) throw new Error("The local board holds a card it cannot read.");
  return parsed;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function toCheckpoint(latest: LatestCheckpoint | null): CardCheckpoint | null {
  if (!latest?.summary) return null;
  return {
    agent: latest.agent,
    host: latest.host ?? null,
    createdAt: latest.createdAt,
    request: latest.request ?? null,
    summary: latest.summary,
    nextStep: latest.nextStep ?? null,
    nextStepFrom: latest.nextStepFrom
      ? {
          agent: latest.nextStepFrom.agent,
          createdAt: latest.nextStepFrom.createdAt,
        }
      : null,
    files: latest.files ?? [],
    git: latest.git
      ? {
          branch: latest.git.branch ?? null,
          head: latest.git.head ?? null,
          wipRef: latest.git.wipRef ?? null,
        }
      : null,
  };
}

/** `BoardQuery.filters` as the store's list query states them. */
function listQuery(query: BoardQuery): WorkItemListQuery {
  const { status, category, priority, tag } = query.filters;
  return {
    ...(status ? { column: status } : {}),
    ...(category ? { category } : {}),
    ...(priority
      ? { priority: priority as WorkItemListQuery["priority"] }
      : {}),
    ...(tag ? { tag } : {}),
  };
}

function countBy(cards: BoardCard[], key: (card: BoardCard) => string | null) {
  const out: Record<string, number> = {};
  for (const card of cards) {
    const value = key(card) ?? "none";
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

/**
 * One local board, bound to the workspace row it was resolved from.
 *
 * ⚠️ Every write answers a `BoardWrite` exactly as the cloud path does — a
 * stale revision is a `conflict` carrying the card as it stands, never a thrown
 * string — so the renderer's conflict dialog works on both.
 *
 * ⚠️ A board that was moved (D7a) refuses every write. Its cards are on the
 * cloud now; an edit here would be one the cloud never sees.
 */
export class LocalBoard {
  constructor(
    readonly store: LocalStore,
    readonly workspace: LocalWorkspace,
  ) {}

  get moved(): boolean {
    return this.workspace.syncedAt !== null;
  }

  /**
   * The board's tag cap, applied the way the cloud applies it: the first
   * `max` tags land and the rest are reported as dropped. The store REFUSES
   * a card over the cap (an agent should hear about it), but a person typing
   * in the composer gets the cloud's behaviour, so both boards read the same.
   */
  #capTags(tags: string[] | undefined): string[] | undefined {
    if (!tags) return tags;
    const max = this.workspace.config.tags.max;
    const kept: string[] = [];
    for (const tag of tags) {
      const key = normalizeTag(tag);
      if (!key || kept.some((entry) => normalizeTag(entry) === key)) continue;
      kept.push(tag);
    }
    return max > 0 ? kept.slice(0, max) : kept;
  }

  #config() {
    return parseBoardConfig({
      board: this.store.boardConfig(this.workspace.id),
    });
  }

  #cards(query: BoardQuery): BoardCard[] {
    return this.store
      .listWorkItems(this.workspace.id, listQuery(query))
      .map(cardOf);
  }

  #stats(query: BoardQuery): { stats: BoardStats; total: number } {
    const cards = this.#cards(query);
    const filtered = Object.values(query.filters).some(Boolean);
    return {
      stats: {
        total: cards.length,
        byColumn: countBy(cards, (card) => card.columnKey),
        byCategory: countBy(cards, (card) => card.categoryKey),
        byPriority: countBy(cards, (card) => card.priority),
      },
      total: filtered
        ? this.store.listWorkItems(this.workspace.id).length
        : cards.length,
    };
  }

  /**
   * The whole board under `query`, every group complete.
   *
   * ⚠️ Read in one go — there is no round trip to save — but stated in the
   * group shape (`groups` with null cursors, `stats`) so the renderer takes the
   * same path it takes for a paged cloud board and never asks for "more".
   */
  view(query: BoardQuery = DEFAULT_BOARD_QUERY): BoardView {
    const config = this.#config();
    const cards = this.#cards(query);
    const counts = this.#stats(query);
    const groups = Object.fromEntries(
      groupSpecs(query, config.columns, config.categories).map((spec) => [
        spec.key,
        { cursor: null, limit: spec.limit },
      ]),
    );
    return {
      workspaceId: this.workspace.id,
      columns: config.columns,
      categories: config.categories,
      labels: config.labels,
      members: [],
      cards,
      migrated: false,
      fetchedAt: new Date().toISOString(),
      stale: false,
      stats: counts.stats,
      total: counts.total,
      query: boardQueryKey(query),
      groups,
      head: this.store.dataVersion(),
    };
  }

  stats(query: BoardQuery): { stats: BoardStats; total: number } {
    return this.#stats(query);
  }

  /** Every group is complete on a local board; there is never a next page. */
  more(): BoardGroupPage {
    return { cards: [], cursor: null, head: this.store.dataVersion() };
  }

  search(query: string): BoardCard[] {
    return this.store
      .listWorkItems(this.workspace.id)
      .map(cardOf)
      .filter((card) => matchesSearch(card, query))
      .slice(0, 20);
  }

  card(cardId: string): BoardCard {
    const detail = this.store.getWorkItem(cardId, {
      workspace: this.workspace.id,
    });
    if (!detail) throw new Error("That card is no longer on this board.");
    return cardOf(detail);
  }

  lookup(taskId: string): BoardCard | null {
    const detail = this.store.getWorkItem(taskId, {
      workspace: this.workspace.id,
    });
    return detail ? cardOf(detail) : null;
  }

  changes(since: number): BoardChanges {
    const { head, items } = this.store.listChanges(this.workspace.id, since);
    return {
      head,
      nextSince: head,
      hasMore: false,
      cards: items.map(cardOf),
      events: [],
    };
  }

  checkpoint(cardId: string): CardCheckpoint | null {
    try {
      return toCheckpoint(
        this.store.listCheckpoints(cardId, { workspace: this.workspace.id })
          .latest,
      );
    } catch (error) {
      if (error instanceof LocalStoreError && error.code === "not_found")
        return null;
      throw error;
    }
  }

  /**
   * One write, answered as the cloud answers it.
   *
   * ⚠️ `conflict` from the store means the card moved past the revision the
   * person is looking at; the answer carries the card as it is NOW so the
   * dialog can show both sides.
   */
  #write(
    cardId: string | null,
    run: () => CardDetail,
    requestedTags?: string[],
  ): BoardWrite {
    if (this.moved) return { kind: "error", message: MOVED_MESSAGE };
    try {
      const card = cardOf(noting(this.store, run));
      return {
        kind: "ok",
        card,
        droppedTags: droppedTags(requestedTags, card.tags),
      };
    } catch (error) {
      if (error instanceof LocalStoreError) {
        if (error.code === "conflict" && cardId) {
          const current = this.store.getWorkItem(cardId, {
            workspace: this.workspace.id,
          });
          if (current)
            return {
              kind: "conflict",
              message: "Someone else changed this card.",
              current: cardOf(current),
            };
        }
        if (error.code === "not_found")
          return {
            kind: "error",
            message: "That card is no longer on this board.",
          };
        return { kind: "error", message: messageOf(error) };
      }
      throw error;
    }
  }

  create(draft: BoardCardDraft): BoardWrite {
    return this.#write(
      null,
      () =>
        this.store.createWorkItem(this.workspace.id, {
          title: draft.title,
          body: draft.body ?? null,
          categoryKey: draft.categoryKey ?? null,
          columnKey: draft.columnKey ?? null,
          priority: draft.priority ?? null,
          tags: this.#capTags(draft.tags) ?? [],
        }),
      draft.tags,
    );
  }

  update(cardId: string, patch: BoardCardPatch, revision: number): BoardWrite {
    // ⚠️ Refused, not dropped: a write that "worked" while silently ignoring
    // the field somebody changed is the one outcome nobody can see.
    if (patch.assignees)
      return { kind: "error", message: `Assigning ${CLOUD_ONLY_SUFFIX}` };
    if (patch.dueAt !== undefined && patch.dueAt !== null)
      return { kind: "error", message: `A due date ${CLOUD_ONLY_SUFFIX}` };
    if (patch.estimate !== undefined && patch.estimate !== null)
      return { kind: "error", message: `An estimate ${CLOUD_ONLY_SUFFIX}` };
    const type =
      patch.type === "epic" || patch.type === "issue" || patch.type === "task"
        ? patch.type
        : undefined;
    return this.#write(
      cardId,
      () =>
        this.store.updateWorkItem(
          cardId,
          {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.priority !== undefined
              ? { priority: patch.priority }
              : {}),
            ...(patch.tags !== undefined
              ? { tags: this.#capTags(patch.tags) }
              : {}),
            ...(patch.categoryKey !== undefined
              ? { categoryKey: patch.categoryKey }
              : {}),
            ...(patch.parentId !== undefined
              ? { parentId: patch.parentId }
              : {}),
            ...(type ? { type } : {}),
          },
          { workspace: this.workspace.id, ifRevision: revision },
        ),
      patch.tags,
    );
  }

  move(
    cardId: string,
    columnKey: string | null,
    placement: BoardPlacement | undefined,
  ): BoardWrite {
    return this.#write(cardId, () =>
      this.store.setStatus(cardId, columnKey, {
        workspace: this.workspace.id,
        placement: placement ?? null,
      }),
    );
  }

  toggle(
    cardId: string,
    key: string,
    checked: boolean,
    revision: number,
  ): BoardWrite {
    return this.#write(cardId, () =>
      this.store.toggleChecklistItem(
        cardId,
        key,
        { checked },
        { workspace: this.workspace.id, ifRevision: revision },
      ),
    );
  }

  setChecklist(
    cardId: string,
    items: BoardChecklistDraft[],
    revision: number,
  ): BoardWrite {
    return this.#write(cardId, () =>
      this.store.updateWorkItem(
        cardId,
        { checklist: items },
        { workspace: this.workspace.id, ifRevision: revision },
      ),
    );
  }

  /** "Delete" — a tombstone, as on the cloud. Already gone is a success. */
  archive(cardId: string): void {
    if (this.moved) throw new Error(MOVED_MESSAGE);
    const live = this.store.getWorkItem(cardId, {
      workspace: this.workspace.id,
    });
    if (!live) {
      const gone = this.store.getWorkItem(cardId, {
        workspace: this.workspace.id,
        includeDeleted: true,
      });
      if (gone) return;
      throw new Error("That card is no longer on this board.");
    }
    noting(this.store, () =>
      this.store.deleteWorkItem(live.id, { workspace: this.workspace.id }),
    );
  }

  /** Every card off the board, confirmed by the board's own slug. */
  purge(slug: string): { deleted: number } {
    if (this.moved) throw new Error(MOVED_MESSAGE);
    if (slug !== this.workspace.slug)
      throw new Error("Type the project's key exactly to remove its issues.");
    const cards = this.store.listWorkItems(this.workspace.id);
    for (const card of cards)
      noting(this.store, () =>
        this.store.deleteWorkItem(card.id, { workspace: this.workspace.id }),
      );
    return { deleted: cards.length };
  }
}

/** The local board `workspaceId` names, or null when it is not a local id. */
export function localBoard(workspaceId: string): LocalBoard | null {
  const workspace = findLocalWorkspace(workspaceId);
  const store = localStore();
  return workspace && store ? new LocalBoard(store, workspace) : null;
}

/** Workspace-level writes, with the watch moved past them like card writes. */
export function writeLocal<T>(write: (store: LocalStore) => T): T {
  const store = requireLocalStore();
  return noting(store, () => write(store));
}
