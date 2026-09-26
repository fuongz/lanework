import {
  type BoardActivity,
  type BoardActivityPage,
  type BoardAssignees,
  type BoardAttachment,
  type BoardAttachmentDraft,
  type BoardCard,
  type BoardCardDraft,
  type BoardCardPatch,
  type BoardCategory,
  type BoardChanges,
  type BoardChecklistDraft,
  type BoardChecklistItem,
  type BoardChecklistProgress,
  type BoardColumn,
  type BoardGroupPage,
  type BoardLabel,
  type BoardMember,
  type BoardPlacement,
  type BoardPresence,
  type BoardQuery,
  type BoardStats,
  type BoardWrite,
  matchesSearch,
  normalizeTag,
  type Workspace,
} from "../../../shared/workspaces";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the whole list: a malformed response must never look like no projects. */
export function parseWorkspaces(value: unknown): Workspace[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    throw new Error(
      "The service returned an invalid workspace list. Try again.",
    );
  const slugs = new Set<string>();
  return value.workspaces.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("The service returned an invalid workspace. Try again.");
    const row = entry as Record<string, unknown>;
    if (
      !text(row.slug) ||
      !text(row.name) ||
      slugs.has(row.slug) ||
      !(row.path === null || text(row.path)) ||
      !(row.baseBranch === null || text(row.baseBranch))
    )
      throw new Error("The service returned an invalid workspace. Try again.");
    slugs.add(row.slug);
    return {
      // ⚠️ Absent, not invalid, on a control plane older than the field. This
      // parser DID require it for one commit, and the result was every real
      // workspace refused with "invalid workspace" — a strict reader turning a
      // deploy-order problem into a broken app. The board is what needs an id;
      // the list is not.
      id: text(row.id) ? row.id : null,
      slug: row.slug,
      name: row.name,
      path: row.path,
      baseBranch: row.baseBranch,
    };
  });
}

/**
 * Cards per page.
 *
 * ⚠️ NOT the API's advertised `limit` maximum of 200, and it must stay under 100.
 * The board's list routes load a page's tags with one
 * `where work_item_id in (?, …)` — one bound parameter per card — and D1 caps a
 * statement at 100 of them, so a page of 200 comes back
 * `D1_ERROR: too many SQL variables` → HTTP 500 → this app falls back to the
 * cached board and says "Offline". Observed the day a board crossed 100 cards.
 * The server-side fix is to chunk that `in` list; until it ships, asking for
 * fewer cards per page is what keeps a big board readable.
 */
const PAGE = 50;

/** One request against the control plane, with this app's error vocabulary. */
async function call(
  record: MachineRecord,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${resolveApi(record.apiUrl)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${record.secret}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Could not reach your board. Check your connection and try again.",
    );
  }
  if (response.status === 401)
    throw new Error(
      "This machine no longer has access. Sign in again to load your board.",
    );
  return response;
}

async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("The service returned an invalid response. Try again.");
  }
}

export async function fetchWorkspaces(
  record: MachineRecord,
): Promise<Workspace[]> {
  // ⚠️ `/v1/sync/state`, the MACHINE surface. `/v1/workspaces` is `sessionAuth`
  // end to end and answers this app's credential with 401 by design.
  const response = await call(record, "/v1/sync/state");
  if (!response.ok)
    throw new Error(
      `Could not load your workspaces (HTTP ${response.status}). Try again.`,
    );
  return parseWorkspaces(await body(response));
}

const priority = (value: unknown): BoardCard["priority"] =>
  value === "low" || value === "medium" || value === "high" ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => text(entry))
    : [];

function parseChecklist(value: unknown): BoardChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (!text(row.key)) return [];
    return [
      {
        key: row.key,
        section: text(row.section) ? row.section : "decisions",
        text: text(row.text) ? row.text : "",
        checked: row.checked === true,
        checkedAt: text(row.checkedAt) ? row.checkedAt : null,
        note: text(row.note) ? row.note : null,
        group: text(row.group) ? row.group : null,
      },
    ];
  });
}

function parseAssignees(value: unknown): BoardAssignees {
  const row =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return { users: strings(row.users), agents: strings(row.agents) };
}

/**
 * One card.
 *
 * ⚠️ A card whose `id`, `revision` or `columnKey` is missing is DROPPED rather
 * than defaulted. Those three are what an edit is addressed by — a card with a
 * guessed revision would send `If-Match: NaN` and a card with a guessed lane
 * would render in the wrong column — so a malformed row is better absent than
 * plausible.
 */
export function parseCard(value: unknown): BoardCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    !text(row.id) ||
    typeof row.revision !== "number" ||
    !Number.isInteger(row.revision) ||
    !text(row.columnKey)
  )
    return null;
  return {
    id: row.id,
    revision: row.revision,
    taskId: text(row.taskId) ? row.taskId : null,
    title: text(row.title) ? row.title : "Untitled",
    body: typeof row.body === "string" ? row.body : "",
    columnKey: row.columnKey,
    categoryKey: text(row.categoryKey) ? row.categoryKey : null,
    priority: priority(row.priority),
    tags: strings(row.tags),
    rank: text(row.rank) ? row.rank : "",
    createdAt: text(row.createdAt) ? row.createdAt : null,
    updatedAt: text(row.updatedAt) ? row.updatedAt : null,
    type: text(row.type) ? row.type : "issue",
    parentId: text(row.parentId) ? row.parentId : null,
    estimate:
      typeof row.estimate === "number" && Number.isFinite(row.estimate)
        ? row.estimate
        : null,
    dueAt: text(row.dueAt) ? row.dueAt : null,
    archivedAt: text(row.archivedAt) ? row.archivedAt : null,
    // ⚠️ Keyed on the field being PRESENT, not on it being a non-empty array.
    // A list read serializes without parts, so `checklist` is absent — and
    // reading that as `[]` is what made every card on the board render as
    // having no decisions. Absent means "not asked"; `[]` means "asked, none".
    checklist: "checklist" in row ? parseChecklist(row.checklist) : null,
    // ⚠️ A SEPARATE key, and it must stay separate. The check above keys on
    // `checklist` being present to tell a list read from a card read; folding
    // the count in under that name would make every card on a board look like
    // it has no decisions, which is the exact bug the comment above records.
    checklistProgress: parseProgress(row.checklistProgress),
    assignees: "assignees" in row ? parseAssignees(row.assignees) : null,
    // ⚠️ Every one of these five keys on the same rule as `checklist` above:
    // PRESENCE decides, not truthiness. A list read serializes without parts, so
    // reading an absent `subscribed` as `false` would draw "Subscribe" on a card
    // the reader is in fact following — and one click would then unfollow it.
    subscribers: "subscribers" in row ? strings(row.subscribers) : null,
    subscribed: "subscribed" in row ? row.subscribed === true : null,
    favorite: "favorite" in row ? row.favorite === true : null,
    commentCount:
      typeof row.commentCount === "number" &&
      Number.isInteger(row.commentCount) &&
      row.commentCount >= 0
        ? row.commentCount
        : null,
    attachments:
      "attachments" in row ? parseAttachments(row.attachments) : null,
  };
}

function parseAttachments(value: unknown): BoardAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (!text(row.id) || !text(row.name) || !text(row.reference)) return [];
    return [
      {
        id: row.id,
        name: row.name,
        reference: row.reference,
        mimeType: text(row.mimeType) ? row.mimeType : null,
        sizeBytes:
          typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes)
            ? row.sizeBytes
            : null,
        sourceKind: text(row.sourceKind) ? row.sourceKind : null,
      },
    ];
  });
}

/**
 * The `{ done, total }` a board read states for every card.
 *
 * ⚠️ Null for a service that does not send it, NOT `{ 0, 0 }`. This app talks to
 * a control plane it does not deploy in lockstep with, and "0 of 0 decisions" is
 * a claim — drawn on screen as an empty chip — where "I was not told" is the
 * truth. The list draws nothing at all for null.
 */
function parseProgress(value: unknown): BoardChecklistProgress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const done = row.done;
  const total = row.total;
  if (typeof done !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(done) || !Number.isFinite(total) || total < 0)
    return null;
  // A `done` above `total` is the service disagreeing with itself; clamping
  // beats rendering `9/3`.
  return { done: Math.max(0, Math.min(done, total)), total };
}

export function parseBoardConfig(value: unknown): {
  columns: BoardColumn[];
  categories: BoardCategory[];
  labels: BoardLabel[];
  members: BoardMember[];
  migratedAt: string | null;
} {
  const board =
    value && typeof value === "object" && "board" in value
      ? ((value as { board: unknown }).board as Record<string, unknown>)
      : null;
  if (!board)
    throw new Error("The service returned an invalid board. Try again.");

  const columns = (Array.isArray(board.columns) ? board.columns : []).flatMap(
    (entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (!text(row.key)) return [];
      return [
        {
          key: row.key,
          name: text(row.name) ? row.name : row.key,
          role: text(row.role) ? row.role : null,
          icon: text(row.icon) ? row.icon : "circle-dashed",
          tone: text(row.tone) ? row.tone : "neutral",
          position: typeof row.position === "number" ? row.position : index,
        },
      ];
    },
  );
  // ⚠️ A board with no lanes cannot be drawn, so an empty list is an error
  // rather than an empty screen — the same call the API's own validator makes.
  if (!columns.length)
    throw new Error("This board has no columns. Open it on the web to fix it.");

  const categories = (
    Array.isArray(board.categories) ? board.categories : []
  ).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (!text(row.key)) return [];
    return [
      {
        key: row.key,
        name: text(row.name) ? row.name : row.key,
        prefix: text(row.prefix) ? row.prefix : "",
        tone: text(row.tone) ? row.tone : "neutral",
      },
    ];
  });

  // ⚠️ An empty list here is a perfectly healthy board, unlike `columns` above:
  // a board nobody has given colours to still draws every tag, in neutral.
  const labels = (Array.isArray(board.labels) ? board.labels : []).flatMap(
    (entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (!text(row.key)) return [];
      return [
        {
          key: row.key,
          name: text(row.name) ? row.name : row.key,
          tone: text(row.tone) ? row.tone : "neutral",
          position: typeof row.position === "number" ? row.position : index,
        },
      ];
    },
  );

  const members = (Array.isArray(board.members) ? board.members : []).flatMap(
    (entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (!text(row.userId)) return [];
      return [
        {
          userId: row.userId,
          // The id is a worse name than a name and a better one than nothing —
          // it is exactly what the audit log says happened.
          name: text(row.name) ? row.name : row.userId,
          image: text(row.image) ? row.image : null,
          role: text(row.role) ? row.role : "member",
        },
      ];
    },
  );

  return {
    columns: [...columns].sort((a, b) => a.position - b.position),
    categories,
    labels: [...labels].sort((a, b) => a.position - b.position),
    members,
    migratedAt: text(board.migratedAt) ? board.migratedAt : null,
  };
}

/** Every card on a board, following the cursor rather than one page. */
export async function fetchCards(
  record: MachineRecord,
  workspaceId: string,
): Promise<BoardCard[]> {
  const cards: BoardCard[] = [];
  let cursor: string | null = null;
  // ⚠️ The ceiling is a CARD count, not a page count: shrinking `PAGE` must not
  // quietly shrink how much of a board this reads. 8000 cards was the reach
  // before, and it stays the reach.
  for (let page = 0; page < 8000 / PAGE; page++) {
    const response = await call(
      record,
      `/v1/boards/${workspaceId}/items?limit=${PAGE}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    if (!response.ok)
      throw new Error(
        `Could not load this board (HTTP ${response.status}). Try again.`,
      );
    const payload = (await body(response)) as {
      items?: unknown[];
      cursor?: unknown;
    };
    for (const entry of payload.items ?? []) {
      const card = parseCard(entry);
      if (card) cards.push(card);
    }
    cursor = text(payload.cursor) ? payload.cursor : null;
    if (!cursor) break;
  }
  return cards;
}

/**
 * `GET /items?q=` — the board's own search (FE-18), at most 20 cards.
 *
 * ⚠️ Every card the service returns is checked against the query again here.
 * A service older than `q` ignores the parameter and answers with the first
 * page of the board, and showing that as "results" would be twenty cards that
 * have nothing to do with what was typed.
 */
export async function searchCards(
  record: MachineRecord,
  workspaceId: string,
  query: string,
): Promise<BoardCard[]> {
  const params = new URLSearchParams({ q: query, limit: "20" });
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items?${params.toString()}`,
  );
  if (!response.ok)
    throw new Error(`Could not search this board (HTTP ${response.status}).`);
  const payload = (await body(response)) as { items?: unknown[] };
  const cards: BoardCard[] = [];
  for (const entry of payload.items ?? []) {
    const card = parseCard(entry);
    if (card && matchesSearch(card, query)) cards.push(card);
  }
  return cards;
}

/** The To-Do lane's first page — the lane people work from (FE-17/D2). */
const START_LANE_PAGE = 50;
/** Every other group's first page, and every "Load more" after it. */
const GROUP_PAGE = 20;

/** One group of a query, as the list endpoint is asked for it. */
export type GroupSpec = { key: string; params: URLSearchParams; limit: number };

/** Every group `query` draws, given the board's lanes and categories. */
export function groupSpecs(
  query: BoardQuery,
  columns: BoardColumn[],
  categories: BoardCategory[],
): GroupSpec[] {
  const { status, category, priority, tag } = query.filters;
  // The query's own filters ride on every group; the one on the grouped
  // dimension instead narrows WHICH groups there are.
  const base = (): URLSearchParams => {
    const params = new URLSearchParams();
    if (status && query.groupBy !== "status") params.set("column", status);
    if (category && query.groupBy !== "category")
      params.set("category", category);
    if (priority && query.groupBy !== "priority")
      params.set("priority", priority);
    if (tag) params.set("tag", tag);
    return params;
  };
  const spec = (key: string, field: string, limit: number): GroupSpec => {
    const params = base();
    params.set(field, key);
    return { key, params, limit };
  };

  if (query.groupBy === "status")
    return columns
      .filter((column) => !status || column.key === status)
      .map((column) =>
        spec(
          column.key,
          "column",
          column.role === "start" ? START_LANE_PAGE : GROUP_PAGE,
        ),
      );
  if (query.groupBy === "priority")
    return ["high", "medium", "low", "none"]
      .filter((key) => !priority || key === priority)
      .map((key) => spec(key, "priority", GROUP_PAGE));
  return [...categories.map((entry) => entry.key), "none"]
    .filter((key) => !category || key === category)
    .map((key) => spec(key, "category", GROUP_PAGE));
}

/** One page of one group. */
export async function fetchGroup(
  record: MachineRecord,
  workspaceId: string,
  group: GroupSpec,
  cursor: string | null = null,
): Promise<BoardGroupPage> {
  const params = new URLSearchParams(group.params);
  params.set("limit", String(group.limit));
  if (cursor) params.set("cursor", cursor);
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items?${params.toString()}`,
  );
  if (!response.ok)
    throw new Error(
      `Could not load this board (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as {
    items?: unknown[];
    cursor?: unknown;
    head?: unknown;
  };
  const cards: BoardCard[] = [];
  for (const entry of payload.items ?? []) {
    const card = parseCard(entry);
    if (card) cards.push(card);
  }
  return {
    cards,
    cursor: text(payload.cursor) ? payload.cursor : null,
    head:
      typeof payload.head === "number" && Number.isInteger(payload.head)
        ? payload.head
        : null,
  };
}

function parseCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object")
    for (const [key, n] of Object.entries(value))
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  return out;
}

/**
 * The board's counts under `filters`, or null from a service older than
 * `/stats` (FE-17) — the caller then reads the whole board, as it used to.
 */
export async function fetchStats(
  record: MachineRecord,
  workspaceId: string,
  filters: BoardQuery["filters"],
): Promise<BoardStats | null> {
  const params = new URLSearchParams();
  if (filters.status) params.set("column", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.tag) params.set("tag", filters.tag);
  const query = params.toString();
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/stats${query ? `?${query}` : ""}`,
  );
  if (response.status === 404) {
    // ⚠️ 404 is ALSO what an unknown board answers. That board's own reads
    // fail right after this and say so; here it only means "no counts".
    return null;
  }
  if (!response.ok)
    throw new Error(
      `Could not load this board (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as { stats?: Record<string, unknown> };
  const stats = payload.stats ?? {};
  return {
    total: typeof stats.total === "number" ? stats.total : 0,
    byColumn: parseCounts(stats.byColumn),
    byCategory: parseCounts(stats.byCategory),
    byPriority: parseCounts(stats.byPriority),
  };
}

/**
 * The board's agent presence (BE-16), or none from a service older than
 * `/presence`.
 *
 * ⚠️ Malformed rows are dropped one by one rather than failing the read.
 * Presence is a hint drawn on top of the board; one bad row must not cost the
 * others.
 */
export async function fetchPresence(
  record: MachineRecord,
  workspaceId: string,
): Promise<BoardPresence[]> {
  const response = await call(record, `/v1/boards/${workspaceId}/presence`);
  if (response.status === 404) return [];
  if (!response.ok)
    throw new Error(
      `Could not load who is working on this board (HTTP ${response.status}).`,
    );
  const payload = (await body(response)) as { presence?: unknown };
  const rows = Array.isArray(payload.presence) ? payload.presence : [];
  const out: BoardPresence[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r.workItemId !== "string" ||
      typeof r.userId !== "string" ||
      typeof r.agent !== "string" ||
      typeof r.lastSeenAt !== "string"
    )
      continue;
    out.push({
      cardId: r.workItemId,
      userId: r.userId,
      agent: r.agent,
      machineId: typeof r.machineId === "string" ? r.machineId : null,
      lastSeenAt: r.lastSeenAt,
    });
  }
  return out;
}

export async function fetchBoardConfig(
  record: MachineRecord,
  workspaceId: string,
): Promise<ReturnType<typeof parseBoardConfig>> {
  const response = await call(record, `/v1/boards/${workspaceId}/config`);
  if (!response.ok)
    throw new Error(
      `Could not load this board (HTTP ${response.status}). Try again.`,
    );
  return parseBoardConfig(await body(response));
}

/**
 * Which of the tags a write asked for did not land on the card.
 *
 * ⚠️ Reported in the words the USER typed, not normalized. "ui polish was
 * dropped" is a sentence about the thing they wrote; "ui-polish was dropped"
 * sends them looking for a tag they never typed.
 */
function droppedTags(
  requested: string[] | undefined,
  kept: string[],
): string[] {
  if (!requested?.length) return [];
  const landed = new Set(kept.map(normalizeTag));
  const seen = new Set<string>();
  return requested.filter((tag) => {
    const key = normalizeTag(tag);
    // An empty normalization (`"###"`) never lands and is never reported: the
    // board discards it, and so would any reader of this list.
    if (!key || landed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Turn a write response into something the UI can act on.
 *
 * ⚠️ A 409 becomes a `conflict` carrying the server's own copy of the card, not
 * an error string. The API sends the card back for exactly this reason, and a
 * dialog that can show both sides is the difference between "try again" and a
 * user deciding which version is right.
 *
 * ⚠️ There is deliberately NO automatic retry here, unlike the agent-facing
 * path. A person is looking at this card; silently replaying their edit on top
 * of somebody else's is the one outcome nobody asked for.
 */
async function readWrite(
  response: Response,
  /** The tags this write ASKED for, when it named any. See `droppedTags`. */
  requestedTags?: string[],
): Promise<BoardWrite> {
  const payload = (await body(response)) as {
    item?: unknown;
    error?: unknown;
    revision?: unknown;
  };
  if (response.ok) {
    const card = parseCard(payload.item);
    return card
      ? { kind: "ok", card, droppedTags: droppedTags(requestedTags, card.tags) }
      : { kind: "error", message: "The service returned an invalid card." };
  }
  if (response.status === 409) {
    const current = parseCard(payload.item);
    if (current)
      return {
        kind: "conflict",
        message: text(payload.error)
          ? payload.error
          : "Someone else changed this card.",
        current,
      };
  }
  return {
    kind: "error",
    message: text(payload.error)
      ? payload.error
      : `The board refused the change (HTTP ${response.status}).`,
  };
}

/**
 * Move a card between lanes, within a lane, or both — in one request.
 *
 * ⚠️ `placement` travels WITH the lane rather than as a second call. The API
 * takes both because a move that changed the column and then the position is
 * two writes, and a second client reading between them sees the card in a place
 * neither user put it.
 */
export async function moveCard(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  columnKey: string | null,
  placement?: BoardPlacement,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify({
        // ⚠️ The key is OMITTED rather than sent as null for a pure reorder.
        // The API reads a missing `columnKey` as "keep the lane it is in"; a
        // literal null is a value its parser has to reject.
        ...(columnKey === null ? {} : { columnKey }),
        ...(placement ? { placement } : {}),
      }),
    }),
  );
}

/**
 * Edit a card, against the revision the user is looking at.
 *
 * ⚠️ `If-Match` is not optional here, unlike on `move`. The endpoint answers
 * 428 without it, and that is the correct design: this writes text a human
 * wrote, and landing it on a revision they never read is how one person's edit
 * silently erases another's.
 */
export async function updateCard(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  patch: BoardCardPatch,
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items/${cardId}`, {
      method: "PATCH",
      headers: { "if-match": String(revision) },
      body: JSON.stringify(patch),
    }),
    patch.tags,
  );
}

/** One card with its checklist and assignees — the read a list cannot give. */
export async function fetchCard(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
): Promise<BoardCard> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}`,
  );
  if (!response.ok)
    throw new Error(
      `Could not load this card (HTTP ${response.status}). Try again.`,
    );
  const card = parseCard(((await body(response)) as { item?: unknown }).item);
  if (!card) throw new Error("The service returned an invalid card.");
  return card;
}

/**
 * The card a human named — `FE-06`.
 *
 * ⚠️ A 404 becomes `null`, and every other failure still throws. "No card
 * carries that id" is an answer a deep link can legitimately get; folding it in
 * with "the board could not be read" would make a typo and an outage look the
 * same on screen.
 */
export async function lookupCard(
  record: MachineRecord,
  workspaceId: string,
  taskId: string,
): Promise<BoardCard | null> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/lookup?taskId=${encodeURIComponent(taskId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Could not look up that card (HTTP ${response.status}). Try again.`,
    );
  const card = parseCard(((await body(response)) as { item?: unknown }).item);
  if (!card) throw new Error("The service returned an invalid card.");
  return card;
}

/**
 * What changed since a cursor.
 *
 * ⚠️ `nextSince` is echoed from the SERVER, never derived. The feed is
 * monotonic but not contiguous — `since + 1` names a seq that may not exist,
 * and board-level events carry no card to advance past — so a client computing
 * its own cursor asks for the same delta forever.
 */
export async function fetchChanges(
  record: MachineRecord,
  workspaceId: string,
  since: number,
): Promise<BoardChanges> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/changes?since=${since}&limit=${PAGE}`,
  );
  if (!response.ok)
    throw new Error(
      `Could not read board changes (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as {
    head?: unknown;
    nextSince?: unknown;
    hasMore?: unknown;
    items?: unknown[];
    events?: unknown[];
  };
  const seq = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : fallback;
  const head = seq(payload.head, since);
  return {
    head,
    // ⚠️ Falls back to `since`, NOT to `head`. A malformed cursor that became
    // the head would silently mark this client caught up on changes it never
    // read; standing still costs one repeated request and loses nothing.
    nextSince: seq(payload.nextSince, since),
    hasMore: payload.hasMore === true,
    cards: (payload.items ?? []).flatMap((entry) => {
      const card = parseCard(entry);
      return card ? [card] : [];
    }),
    events: (payload.events ?? []).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.seq !== "number" || !text(row.verb)) return [];
      return [{ seq: row.seq, verb: row.verb }];
    }),
  };
}

export async function toggleChecklistItem(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  key: string,
  checked: boolean,
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(
      record,
      `/v1/boards/${workspaceId}/items/${cardId}/checklist/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        // ⚠️ Sent even though this endpoint treats it as optional: the user is
        // looking at a specific revision of this card, and a tick that lands on
        // a newer one is a decision they did not make.
        headers: { "if-match": String(revision) },
        body: JSON.stringify({ checked }),
      },
    ),
  );
}

/**
 * Replace a card's checklist.
 *
 * ⚠️ `If-Match` is required by the endpoint, and rightly: this rewrites a list
 * of decisions a human wrote, and landing it on a revision they never read
 * discards somebody else's edits without a word.
 */
export async function replaceChecklist(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  items: BoardChecklistDraft[],
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items/${cardId}/checklist`, {
      method: "PUT",
      headers: { "if-match": String(revision) },
      body: JSON.stringify({ items }),
    }),
  );
}

/**
 * Put a new card on the board.
 *
 * ⚠️ Every optional field is OMITTED rather than sent as null. The service reads
 * a missing `columnKey` as "the board's first lane" and a missing `categoryKey`
 * as "no category"; a literal null is a value its parser has to reject, and this
 * used to send `{ title }` alone for exactly that reason.
 *
 * ⚠️ `draft.tags` is handed to `readWrite` as well as sent. The board caps tags
 * and applies the cap silently, so comparing what was asked for against what
 * came back is the only way to tell somebody a tag did not land.
 */
export async function createCard(
  record: MachineRecord,
  workspaceId: string,
  draft: BoardCardDraft,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, `/v1/boards/${workspaceId}/items`, {
      method: "POST",
      body: JSON.stringify({
        title: draft.title,
        ...(draft.body ? { body: draft.body } : {}),
        ...(draft.categoryKey ? { categoryKey: draft.categoryKey } : {}),
        ...(draft.columnKey ? { columnKey: draft.columnKey } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.tags?.length ? { tags: draft.tags } : {}),
      }),
    }),
    draft.tags,
  );
}

/**
 * One entry of a card's history, from the merged feed.
 *
 * ⚠️ A row this cannot read is DROPPED rather than defaulted. An activity line
 * is a claim about what somebody did — "decio set priority to Urgent" — and a
 * half-parsed one would put a sentence on screen that nothing actually says.
 */
function parseActivity(value: unknown): BoardActivity | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!text(row.id) || !text(row.at)) return null;

  if (row.kind === "comment") {
    return {
      kind: "comment",
      id: row.id,
      authorKind: text(row.authorKind) ? row.authorKind : "user",
      authorRef: text(row.authorRef) ? row.authorRef : "",
      authorUserId: text(row.authorUserId) ? row.authorUserId : null,
      // ⚠️ Null is MEANINGFUL here — a retracted comment — so it is kept rather
      // than turned into an empty string the thread would render as a blank.
      body: typeof row.body === "string" ? row.body : null,
      at: row.at,
      editedAt: text(row.editedAt) ? row.editedAt : null,
      deletedAt: text(row.deletedAt) ? row.deletedAt : null,
    };
  }
  if (row.kind !== "audit" || !text(row.verb)) return null;
  return {
    kind: "audit",
    id: row.id,
    seq: typeof row.seq === "number" ? row.seq : 0,
    verb: row.verb,
    actorKind: text(row.actorKind) ? row.actorKind : "user",
    actorUserId: text(row.actorUserId) ? row.actorUserId : null,
    actorMachineId: text(row.actorMachineId) ? row.actorMachineId : null,
    diff:
      row.diff && typeof row.diff === "object" && !Array.isArray(row.diff)
        ? (row.diff as Record<string, unknown>)
        : null,
    at: row.at,
  };
}

/**
 * One page of a card's activity, oldest first.
 *
 * ⚠️ The cursor is the SERVICE's and travels back verbatim. It is keyed on
 * `(createdAt, id)` across two tables, so there is nothing here that could
 * compute the next one — and a client that tried would page itself through the
 * same stretch of a conversation forever.
 */
export async function fetchActivity(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  cursor?: string | null,
): Promise<BoardActivityPage> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/activity${
      cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    }`,
  );
  if (!response.ok)
    throw new Error(
      `Could not load this card's activity (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as {
    events?: unknown[];
    cursor?: unknown;
  };
  return {
    events: (payload.events ?? []).flatMap((entry) => {
      const parsed = parseActivity(entry);
      return parsed ? [parsed] : [];
    }),
    cursor: text(payload.cursor) ? payload.cursor : null,
  };
}

/**
 * Say something on a card.
 *
 * ⚠️ No `If-Match`, unlike every card edit. A comment is an append: two people
 * writing at once both succeed, and neither has an earlier version to overwrite.
 */
export async function createComment(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  text_: string,
): Promise<{ id: string }> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/comments`,
    { method: "POST", body: JSON.stringify({ body: text_ }) },
  );
  if (!response.ok)
    throw new Error(
      `Could not post that comment (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as { comment?: { id?: unknown } };
  const id = payload.comment?.id;
  if (!text(id)) throw new Error("The service returned an invalid comment.");
  return { id };
}

/** Reword your own comment. The service refuses anybody else's with a 403. */
export async function editComment(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  commentId: string,
  text_: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/comments/${commentId}`,
    { method: "PATCH", body: JSON.stringify({ body: text_ }) },
  );
  if (response.status === 403)
    throw new Error("Only the author can edit that comment.");
  if (response.status === 409) throw new Error("That comment was deleted.");
  if (!response.ok)
    throw new Error(
      `Could not save that comment (HTTP ${response.status}). Try again.`,
    );
}

/** Retract your own comment. A tombstone on the service, not a row removal. */
export async function deleteComment(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  commentId: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/comments/${commentId}`,
    { method: "DELETE" },
  );
  if (response.status === 403)
    throw new Error("Only the author can delete that comment.");
  if (!response.ok)
    throw new Error(
      `Could not delete that comment (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Follow or unfollow a card; star or unstar it.
 *
 * ⚠️ `PUT`/`DELETE` rather than a toggle, so a retry after a lost response is
 * harmless. Both answer with the state that now holds, which is what the caller
 * renders — never the value it asked for.
 */
async function setFlag(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  path: "subscription" | "favorite",
  on: boolean,
  field: "subscribed" | "favorite",
  noun: string,
): Promise<boolean> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/${path}`,
    { method: on ? "PUT" : "DELETE" },
  );
  if (!response.ok)
    throw new Error(
      `Could not ${on ? "" : "un"}${noun} that card (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as Record<string, unknown>;
  return typeof payload[field] === "boolean" ? payload[field] : on;
}

export const setSubscription = (
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  subscribed: boolean,
): Promise<boolean> =>
  setFlag(
    record,
    workspaceId,
    cardId,
    "subscription",
    subscribed,
    "subscribed",
    "follow",
  );

export const setFavorite = (
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  favorite: boolean,
): Promise<boolean> =>
  setFlag(
    record,
    workspaceId,
    cardId,
    "favorite",
    favorite,
    "favorite",
    "star",
  );

/**
 * Record a file this card refers to.
 *
 * ⚠️ METADATA ONLY. Nothing is uploaded and nothing is fetched — the service
 * stores the reference a caller states and hands it back untouched, so opening
 * one later is this machine's job.
 */
export async function attachFile(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  file: BoardAttachmentDraft,
): Promise<BoardAttachment> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/attachments`,
    {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        reference: file.reference,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(typeof file.sizeBytes === "number"
          ? { sizeBytes: file.sizeBytes }
          : {}),
        sourceKind: "desktop",
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Could not attach that file (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as { attachment?: unknown };
  const [parsed] = parseAttachments([payload.attachment]);
  if (!parsed) throw new Error("The service returned an invalid attachment.");
  return parsed;
}

export async function detachFile(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
  attachmentId: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}/attachments/${attachmentId}`,
    { method: "DELETE" },
  );
  if (!response.ok)
    throw new Error(
      `Could not remove that file (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Remove every card on a board, permanently (FE-14).
 *
 * ⚠️ 404 means the SERVICE is older than this app, not that the board is
 * gone — `openBoard` answers 404 for a board you cannot see, and this app only
 * offers the action on a board it just read. Saying "cannot remove issues yet"
 * is the honest reading; "not found" would send someone looking for a board
 * that is right there.
 */
export async function purgeIssues(
  record: MachineRecord,
  workspaceId: string,
  slug: string,
): Promise<{ deleted: number }> {
  const response = await call(record, `/v1/boards/${workspaceId}/purge`, {
    method: "POST",
    body: JSON.stringify({ confirm: slug }),
  });
  if (response.status === 404)
    throw new Error(
      "This Lanework service cannot remove issues yet. Update the service, then try again.",
    );
  if (response.status === 403)
    throw new Error("Only the project's owner can remove its issues.");
  if (!response.ok) {
    const detail = (
      (await body(response).catch(() => null)) as { error?: string } | null
    )?.error;
    throw new Error(
      `Could not remove the issues (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`,
    );
  }
  const payload = (await body(response)) as { deleted?: unknown };
  return {
    deleted: typeof payload.deleted === "number" ? payload.deleted : 0,
  };
}

/**
 * Archive one card — what "Delete" does on this board.
 *
 * ⚠️ `DELETE` on this route is a TOMBSTONE. The service stamps `archivedAt`,
 * bumps the revision and reserves a change `seq` for it, precisely so the change
 * feed can carry the news; a row that disappeared could not be reported at all,
 * and a second machine would keep the card on screen forever.
 *
 * ⚠️ Already archived is a SUCCESS, and the service says so with a plain 200. A
 * client that treated the second click as a failure would report a button
 * broken for having already done what it promised.
 */
export async function archiveCard(
  record: MachineRecord,
  workspaceId: string,
  cardId: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/boards/${workspaceId}/items/${cardId}`,
    { method: "DELETE" },
  );
  if (response.status === 404)
    throw new Error("That card is no longer on this board.");
  if (!response.ok)
    throw new Error(
      `Could not delete that card (HTTP ${response.status}). Try again.`,
    );
}

/**
 * What a migration would bring over.
 *
 * ⚠️ This app cannot RUN the import: building the records means reading
 * `.agents/reviews/**
 * Create one project on the account.
 *
 * ⚠️ `POST /v1/sync/state/workspace`, the MACHINE surface. `POST /v1/workspaces`
 * is `sessionAuth` and refuses this app's credential by design — the same trap
 * that made the workspace-id resolver 401 on every call until it was moved.
 *
 * ⚠️ A 404 is reported as an out-of-date SERVICE, not as a failure of the
 * request. This route is newer than some deployments, and "could not create the
 * project" would send somebody looking for the mistake in the name they typed.
 */
export async function createWorkspace(
  record: MachineRecord,
  /**
   * ⚠️ `path` is the PRIMARY source folder, and sending it is what makes the
   * account record where this project lives on this machine — the same field
   * every other surface reads back as `workspace.path`. Omitted when the
   * project was created without folders: the column is `NOT NULL` on the
   * service's side, so an empty string would put a path nobody chose into the
   * one place clients look to find the code.
   */
  input: { slug: string; name: string; path?: string },
  // ⚠️ `id` is non-nullable in the RETURN type, unlike `Workspace` itself. A
  // service that just created a project on request has no older-shape excuse
  // for not naming it, and the caller opens its board with that id straight
  // after — a nullable id here would push the check into the caller, which is
  // where it was missed the first time.
): Promise<Workspace & { id: string }> {
  const response = await call(record, "/v1/sync/state/workspace", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response.status === 404)
    throw new Error(
      "This Lanework service cannot create projects yet. Update it, then try again.",
    );
  if (response.status === 409)
    throw new Error(
      `Another project on your account already uses the key “${input.slug}”. Try a different name.`,
    );
  if (response.status === 400)
    throw new Error("That name cannot be used. Try letters and numbers.");
  if (!response.ok)
    throw new Error("Could not create that project. Try again.");

  const payload = await body(response);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("workspace" in payload) ||
    !payload.workspace ||
    typeof payload.workspace !== "object"
  )
    throw new Error("The service returned an invalid workspace. Try again.");
  const row = payload.workspace as Record<string, unknown>;
  // ⚠️ Validated as strictly as a listed row, and the id is REQUIRED here
  // unlike in `parseWorkspaces`: a service that just created a project on
  // request has no older-shape excuse for not naming it, and the id is what the
  // next call — opening its board — is addressed by.
  if (!text(row.id) || !text(row.slug) || !text(row.name))
    throw new Error("The service returned an invalid workspace. Try again.");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    path: text(row.path) ? (row.path as string) : null,
    baseBranch: text(row.baseBranch) ? (row.baseBranch as string) : null,
  };
}

/**
 * Rename one project on the account, by CLOUD WORKSPACE ID.
 *
 * ⚠️ `PATCH /v1/sync/state/workspace/:id`, the MACHINE surface. `PATCH
 * /v1/workspaces/:id` is `sessionAuth` and refuses this app's credential by
 * design — the same trap that made the workspace-id resolver 401 on every call
 * until it was moved.
 *
 * ⚠️ Keyed by ID while `deleteWorkspace` below is keyed by SLUG, and the two
 * keys look alike: a uuid matches the service's slug shape (hex runs joined by
 * hyphens). The service refuses the wrong keyspace with a 400 rather than a
 * 404, which is the only reason mixing these two up is a legible mistake — do
 * not "helpfully" pass a slug here.
 *
 * ⚠️ The name only. The service will not change a slug through any route, so
 * nothing keyed by slug on this machine — the folder link above all — has to be
 * rewritten after a rename.
 *
 * ⚠️ A 404 is reported as a project that is GONE rather than a request that
 * failed: the id was read from this account's own state, so the only way it
 * misses is a project deleted from somewhere else in the meantime.
 */
export async function renameWorkspace(
  record: MachineRecord,
  id: string,
  name: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/sync/state/workspace/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  if (response.status === 404)
    throw new Error(
      "That project is no longer on your account. Refresh to see what is left.",
    );
  if (response.status === 400)
    throw new Error("That name cannot be used. Try letters and numbers.");
  if (!response.ok)
    throw new Error(
      `Could not rename that project (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Delete one project from the account, by CLOUD WORKSPACE ID.
 *
 * ⚠️ `DELETE /v1/sync/state/workspace/:id`, the machine surface, and a real
 * delete: the service cascades the paths every machine reported for it. The
 * human surface (`DELETE /v1/workspaces/:id`) archives and can be restored —
 * this one cannot, which is why the only caller is behind a confirmation.
 *
 * ⚠️ Keyed by ID, the same keyspace as `renameWorkspace` above. This route took
 * the SLUG until the service moved it, and that history is why a stale service
 * is DANGEROUS here rather than merely unsupported: the old handler validated
 * its key against a slug pattern, and a uuid matches that pattern, so an id sent
 * to it removes nothing and still answers 200. Nothing in this function can tell
 * that apart from a real delete — which is why its caller in `index.ts` re-reads
 * the account and refuses to report a success the list contradicts.
 *
 * ⚠️ A project with no cloud id therefore cannot be deleted from here at all.
 * That is a service older than the `id` field on `/v1/sync/state`, the same
 * state that stops a board from opening, and the button says so rather than
 * sending a slug this route now refuses with a 400.
 *
 * ⚠️ "Already gone" is a SUCCESS. The service answers 200 either way, and a
 * client that reported 404 as a failure would say a button did not work when it
 * achieved exactly what it promised.
 *
 * ⚠️ Nothing here stops another machine still syncing the same project from
 * pushing it back. The project is the account's, not this machine's.
 */
export async function deleteWorkspace(
  record: MachineRecord,
  id: string,
): Promise<void> {
  const response = await call(
    record,
    `/v1/sync/state/workspace/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (response.status === 404)
    throw new Error(
      "This Lanework service cannot delete projects yet. Update it, then try again.",
    );
  if (!response.ok)
    throw new Error(
      `Could not delete that project (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Create or update the board's lanes, categories and tag cap.
 *
 * ⚠️ It goes FIRST in a migration, and the tag cap travels with it: without the
 * cap the cloud's default of 3 would silently drop the fourth tag of every card
 * on a board that raised its own limit.
 */
export async function putBoardConfig(
  record: MachineRecord,
  workspaceId: string,
  config: unknown,
): Promise<void> {
  const response = await call(record, `/v1/boards/${workspaceId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
  if (!response.ok)
    throw new Error(
      `The board refused its configuration (${response.status}). Nothing was imported.`,
    );
}

/**
 * Send one batch of import records.
 *
 * ⚠️ Returns the server's receipts rather than a boolean. A card the cloud
 * refused — because somebody edited it there — comes back as a `conflict`
 * receipt, and a run reported as a plain success with three conflicts inside it
 * is how a board quietly loses a card.
 */
export async function importRecords(
  record: MachineRecord,
  workspaceId: string,
  records: unknown[],
): Promise<{
  receipts: {
    ref: string;
    status: string;
    taskId?: string | null;
    error?: string;
  }[];
  summary: Record<string, number>;
}> {
  const response = await call(record, `/v1/boards/${workspaceId}/import`, {
    method: "POST",
    body: JSON.stringify({ records }),
  });
  if (!response.ok) {
    // ⚠️ The service's OWN reason, and the file it is about. Reporting only
    // "refused (400)" is what turned a card with one over-long checklist item
    // into a dead button: the API had named the record and the item, and this
    // client threw the explanation away. `records[N]` indexes the batch that
    // was just sent, which is this array.
    const detail = (
      (await body(response).catch(() => null)) as {
        error?: string;
      } | null
    )?.error;
    const index = detail?.match(/records\[(\d+)\]/)?.[1];
    const named =
      index === undefined
        ? undefined
        : (records[Number(index)] as { source?: { ref?: string } } | undefined)
            ?.source?.ref;
    throw new Error(
      [
        `The board refused ${records.length} record(s) (${response.status}).`,
        named ? `In ${named}:` : "",
        detail ?? "",
        "Records already accepted are on the board; run it again to continue.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  const payload = (await body(response)) as {
    receipts?: {
      ref: string;
      status: string;
      taskId?: string | null;
      error?: string;
    }[];
    summary?: Record<string, number>;
  };
  return { receipts: payload.receipts ?? [], summary: payload.summary ?? {} };
}

/**
 * Seal the cutover: the cloud owns these cards from now on.
 *
 * ⚠️ The server COUNTS before it agrees, and a mismatch is a 409 naming both
 * numbers — which this reports verbatim. "Migrated" must never come to mean
 * "somebody clicked a button": every local writer goes read-only on the
 * strength of this flag.
 */
export async function sealBoardMigration(
  record: MachineRecord,
  workspaceId: string,
  items: number,
  manifest: string,
): Promise<{ migratedAt: string | null; error?: string }> {
  const response = await call(record, `/v1/boards/${workspaceId}/migrated`, {
    method: "POST",
    body: JSON.stringify({ items, manifest }),
  });
  const payload = (await body(response).catch(() => ({}))) as {
    migratedAt?: string;
    error?: string;
    expected?: number;
    actual?: number;
  };
  if (!response.ok) {
    const counted =
      payload.expected === undefined || payload.actual === undefined
        ? ""
        : ` — the run accounted for ${payload.expected}, the board holds ${payload.actual}`;
    return {
      migratedAt: null,
      error: `${payload.error ?? `the cutover was refused (${response.status})`}${counted}`,
    };
  }
  return { migratedAt: payload.migratedAt ?? null };
}
