import { COLUMN_ROLES, PRIORITIES, paths } from "@lanework/protocol";
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
  type CardCheckpoint,
  CHECKLIST_SECTIONS,
  type ChecklistSection,
  type ColumnRole,
  matchesSearch,
  normalizeTag,
  type Project,
  parseDispatch,
  parseItemStream,
  parseStreams,
} from "../../../shared/projects";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";
import {
  BodyTooLargeError,
  ICON_BODY_CAP,
  readCappedBytes,
  readCappedJson,
} from "../http-body";

/** Whether `value` is a string with something besides whitespace on it. */
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The account's projects, out of a `/v1/sync/state` answer.
 *
 * The whole list is validated: a malformed response must never look like no
 * projects.
 *
 * @throws when the list or any row in it is malformed, or a slug repeats.
 */
export function parseProjects(value: unknown): Project[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    throw new Error("The service returned an invalid project list. Try again.");
  const slugs = new Set<string>();
  return value.workspaces.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("The service returned an invalid project. Try again.");
    const row = entry as Record<string, unknown>;
    if (
      !text(row.slug) ||
      !text(row.name) ||
      slugs.has(row.slug) ||
      !(row.path === null || text(row.path)) ||
      !(row.baseBranch === null || text(row.baseBranch))
    )
      throw new Error("The service returned an invalid project. Try again.");
    slugs.add(row.slug);
    return {
      // NOTE: Absent, not invalid, on a control plane older than the field.
      // Requiring it refuses every real project with "invalid project": a
      // strict reader turns a deploy-order problem into a broken app. The
      // board is what needs an id; the list is not.
      id: text(row.id) ? row.id : null,
      slug: row.slug,
      name: row.name,
      path: row.path,
      baseBranch: row.baseBranch,
      // Absent from a service older than BE-18; anything but a string is no
      // icon, never a refusal.
      ...(text(row.iconKey) ? { iconKey: row.iconKey } : {}),
    };
  });
}

/**
 * Cards per page.
 *
 * NOTE: NOT the API's advertised `limit` maximum of 200, and it must stay
 * under 100. The board's list routes load a page's tags with one
 * `where work_item_id in (?, …)`, one bound parameter per card, and D1 caps
 * a statement at 100 of them. A page of 200 comes back
 * `D1_ERROR: too many SQL variables` → HTTP 500 → this app falls back to the
 * cached board and says "Offline". The server-side fix is to chunk that `in`
 * list; until it ships, fewer cards per page keeps a big board readable.
 */
const PAGE = 50;

/**
 * One request against the control plane, with this app's error vocabulary.
 *
 * @throws when the service cannot be reached, or answers 401.
 */
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

/**
 * A response's JSON body, at most `JSON_BODY_CAP` bytes of it (FE-78/D8).
 *
 * @throws when the body is too large or not JSON.
 */
async function body(response: Response): Promise<unknown> {
  try {
    return await readCappedJson(response);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      throw new Error("The service sent a response too large to read.");
    throw new Error("The service returned an invalid response. Try again.");
  }
}

/** The account's projects, as this machine's credential may read them. */
export async function fetchProjects(record: MachineRecord): Promise<Project[]> {
  // NOTE: `/v1/sync/state`, the MACHINE surface. `/v1/workspaces` is
  // `sessionAuth` end to end and answers this app's credential with 401 by
  // design.
  const response = await call(record, paths.syncState());
  if (!response.ok)
    throw new Error(
      `Could not load your projects (HTTP ${response.status}). Try again.`,
    );
  return parseProjects(await body(response));
}

const priority = (value: unknown): BoardCard["priority"] =>
  PRIORITIES.find((entry) => entry === value) ?? null;

/** A checklist row's section; a row filed under none is a decision. */
const section = (value: unknown): ChecklistSection =>
  CHECKLIST_SECTIONS.find((entry) => entry === value) ?? "decisions";

/** A lane's role, or null for none or one this app does not know. */
const columnRole = (value: unknown): ColumnRole | null =>
  COLUMN_ROLES.find((entry) => entry === value) ?? null;

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
        section: section(row.section),
        text: text(row.text) ? row.text : "",
        checked: row.checked === true,
        checkedAt: text(row.checkedAt) ? row.checkedAt : null,
        note: text(row.note) ? row.note : null,
        group: text(row.group) ? row.group : null,
        // The stream this verify item proves; null for the lead's.
        stream: parseItemStream(row.stream),
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
 * One card, or null for a row that cannot be one.
 *
 * NOTE: A card whose `id`, `revision` or `columnKey` is missing is DROPPED
 * rather than defaulted. Those three are what an edit is addressed by: a
 * card with a guessed revision would send `If-Match: NaN`, and a card with a
 * guessed lane would render in the wrong column. A malformed row is better
 * absent than plausible.
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
    // NOTE: Keyed on the field being PRESENT, not on it being a non-empty
    // array. A list read serializes without parts, so `checklist` is absent,
    // and reading that as `[]` would make every card on the board render as
    // having no decisions. Absent means "not asked"; `[]` means "asked, none".
    checklist: "checklist" in row ? parseChecklist(row.checklist) : null,
    // How the card splits for sub-agents, read-only here.
    streams: parseStreams(row.streams),
    dispatch: parseDispatch(row.dispatch),
    // NOTE: A SEPARATE key, and it must stay separate. The check above keys
    // on `checklist` being present to tell a list read from a card read.
    // Folding the count in under that name would make every card on a board
    // look like it has no decisions, the bug the comment above describes.
    checklistProgress: parseProgress(row.checklistProgress),
    assignees: "assignees" in row ? parseAssignees(row.assignees) : null,
    // NOTE: Every one of these five keys on the same rule as `checklist`
    // above: PRESENCE decides, not truthiness. A list read serializes without
    // parts, so reading an absent `subscribed` as `false` would draw
    // "Subscribe" on a card the reader is in fact following, and one click
    // would then unfollow it.
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
 * NOTE: Null for a service that does not send it, NOT `{ 0, 0 }`. This app
 * talks to a control plane it does not deploy in lockstep with, and "0 of 0
 * decisions" is a claim (drawn on screen as an empty chip) where "I was not
 * told" is the truth. The list draws nothing at all for null.
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

/**
 * A board's lanes, categories, labels and members, sorted for drawing.
 *
 * @throws when the answer holds no board, or a board with no lanes.
 */
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
          role: columnRole(row.role),
          icon: text(row.icon) ? row.icon : "circle-dashed",
          tone: text(row.tone) ? row.tone : "neutral",
          position: typeof row.position === "number" ? row.position : index,
        },
      ];
    },
  );
  // A board with no lanes cannot be drawn, so an empty list is an error
  // rather than an empty screen: the same call the API's own validator makes.
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

  // An empty list here is a healthy board, unlike `columns` above: a board
  // nobody has given colours to still draws every tag, in neutral.
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
          // The id is a worse name than a name and a better one than nothing:
          // it is what the audit log says happened.
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
  projectId: string,
): Promise<BoardCard[]> {
  const cards: BoardCard[] = [];
  let cursor: string | null = null;
  // NOTE: The ceiling is a CARD count, not a page count: shrinking `PAGE`
  // must not quietly shrink how much of a board this reads. The reach is
  // 8000 cards.
  for (let page = 0; page < 8000 / PAGE; page++) {
    const response = await call(
      record,
      paths.items(
        projectId,
        `limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
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
 * The board's own search, `GET /items?q=`: at most 20 cards.
 *
 * NOTE: Every card the service returns is checked against the query again
 * here. A service older than `q` ignores the parameter and answers with the
 * first page of the board, and showing that as "results" would be twenty
 * cards that have nothing to do with what was typed.
 */
export async function searchCards(
  record: MachineRecord,
  projectId: string,
  query: string,
): Promise<BoardCard[]> {
  const params = new URLSearchParams({ q: query, limit: "20" });
  const response = await call(record, paths.items(projectId, params));
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

/** The To-Do lane's first page: the lane people work from (FE-17/D2). */
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

/**
 * One page of one group.
 *
 * @param cursor where the previous page ended; null for the first page.
 */
export async function fetchGroup(
  record: MachineRecord,
  projectId: string,
  group: GroupSpec,
  cursor: string | null = null,
): Promise<BoardGroupPage> {
  const params = new URLSearchParams(group.params);
  params.set("limit", String(group.limit));
  if (cursor) params.set("cursor", cursor);
  const response = await call(record, paths.items(projectId, params));
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

/** The non-negative counts of a stats map; anything else is left out. */
function parseCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object")
    for (const [key, n] of Object.entries(value))
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  return out;
}

/**
 * The board's counts under `filters`.
 *
 * @returns null from a service older than `/stats`; the caller then reads
 * the whole board instead.
 */
export async function fetchStats(
  record: MachineRecord,
  projectId: string,
  filters: BoardQuery["filters"],
): Promise<BoardStats | null> {
  const params = new URLSearchParams();
  if (filters.status) params.set("column", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.tag) params.set("tag", filters.tag);
  const response = await call(record, paths.boardStats(projectId, params));
  if (response.status === 404) {
    // NOTE: 404 is ALSO what an unknown board answers. That board's own reads
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

/** `value` when it is a non-empty string; otherwise null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/**
 * Where the last agent on a card stopped, or null.
 *
 * NOTE: Null, not an error, for a 404: a service older than BE-17 has no
 * route, and a card nobody checkpointed has nothing to show. Like presence
 * it is a hint beside the card, never a reason for the card to fail to open.
 */
export async function fetchCheckpoint(
  record: MachineRecord,
  projectId: string,
  cardId: string,
): Promise<CardCheckpoint | null> {
  const response = await call(record, paths.itemCheckpoints(projectId, cardId));
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Could not load where the last agent stopped (HTTP ${response.status}).`,
    );
  const payload = (await body(response)) as { latest?: unknown };
  const r = payload.latest;
  if (!r || typeof r !== "object") return null;
  const row = r as Record<string, unknown>;
  const agent = str(row.agent);
  const createdAt = str(row.createdAt);
  const summary = str(row.summary);
  if (!agent || !createdAt || !summary) return null;
  const from =
    row.nextStepFrom && typeof row.nextStepFrom === "object"
      ? (row.nextStepFrom as Record<string, unknown>)
      : null;
  const git =
    row.git && typeof row.git === "object"
      ? (row.git as Record<string, unknown>)
      : null;
  return {
    agent,
    host: str(row.host),
    createdAt,
    request: str(row.request),
    summary,
    nextStep: str(row.nextStep),
    nextStepFrom:
      from && str(from.agent) && str(from.createdAt)
        ? { agent: from.agent as string, createdAt: from.createdAt as string }
        : null,
    files: Array.isArray(row.files)
      ? row.files.filter((f): f is string => typeof f === "string")
      : [],
    git: git
      ? {
          branch: str(git.branch),
          head: str(git.head),
          wipRef: str(git.wipRef),
        }
      : null,
  };
}

/**
 * The board's agent presence, or none from a service older than `/presence`.
 *
 * Malformed rows are dropped one by one rather than failing the read.
 * Presence is a hint drawn on top of the board; one bad row must not cost
 * the others.
 */
export async function fetchPresence(
  record: MachineRecord,
  projectId: string,
): Promise<BoardPresence[]> {
  const response = await call(record, paths.boardPresence(projectId));
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

/** A board's configuration, read through {@link parseBoardConfig}. */
export async function fetchBoardConfig(
  record: MachineRecord,
  projectId: string,
): Promise<ReturnType<typeof parseBoardConfig>> {
  const response = await call(record, paths.boardConfig(projectId));
  if (!response.ok)
    throw new Error(
      `Could not load this board (HTTP ${response.status}). Try again.`,
    );
  return parseBoardConfig(await body(response));
}

/**
 * Which of the tags a write asked for did not land on the card.
 *
 * Reported in the words the USER typed, not normalized. "ui polish was
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
 * A 409 becomes a `conflict` carrying the server's own copy of the card, not
 * an error string. The API sends the card back for this reason, and a
 * dialog that can show both sides is the difference between "try again" and
 * a user deciding which version is right.
 *
 * NOTE: There is NO automatic retry here, unlike the agent-facing path. A
 * person is looking at this card; silently replaying their edit on top of
 * somebody else's is the one outcome nobody asked for.
 *
 * @param requestedTags the tags this write ASKED for, when it named any; see
 * {@link droppedTags}.
 */
async function readWrite(
  response: Response,
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
 * Move a card between lanes, within a lane, or both, in one request.
 *
 * NOTE: `placement` travels WITH the lane rather than as a second call. The
 * API takes both because a move that changed the column and then the
 * position is two writes, and a second client reading between them sees the
 * card in a place neither user put it.
 *
 * @param columnKey the lane to move to; null keeps the lane it is in.
 */
export async function moveCard(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  columnKey: string | null,
  placement?: BoardPlacement,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, paths.itemMove(projectId, cardId), {
      method: "POST",
      body: JSON.stringify({
        // NOTE: The key is OMITTED rather than sent as null for a reorder.
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
 * NOTE: `If-Match` is not optional here, unlike on `move`. The endpoint
 * answers 428 without it, and that is the correct design: this writes text
 * a human wrote, and landing it on a revision they never read is how one
 * person's edit silently erases another's.
 */
export async function updateCard(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  patch: BoardCardPatch,
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, paths.item(projectId, cardId), {
      method: "PATCH",
      headers: { "if-match": String(revision) },
      body: JSON.stringify(patch),
    }),
    patch.tags,
  );
}

/** One card with its checklist and assignees: the read a list cannot give. */
export async function fetchCard(
  record: MachineRecord,
  projectId: string,
  cardId: string,
): Promise<BoardCard> {
  const response = await call(record, paths.item(projectId, cardId));
  if (!response.ok)
    throw new Error(
      `Could not load this card (HTTP ${response.status}). Try again.`,
    );
  const card = parseCard(((await body(response)) as { item?: unknown }).item);
  if (!card) throw new Error("The service returned an invalid card.");
  return card;
}

/**
 * The card a human named by its task id, like `FE-06`.
 *
 * NOTE: A 404 becomes `null`, and every other failure still throws. "No card
 * carries that id" is an answer a deep link can legitimately get; folding it
 * in with "the board could not be read" would make a typo and an outage look
 * the same on screen.
 */
export async function lookupCard(
  record: MachineRecord,
  projectId: string,
  taskId: string,
): Promise<BoardCard | null> {
  const response = await call(record, paths.boardLookup(projectId, { taskId }));
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
 * NOTE: `nextSince` is echoed from the SERVER, never derived. The feed is
 * monotonic but not contiguous (`since + 1` names a seq that may not exist,
 * and board-level events carry no card to advance past), so a client
 * computing its own cursor asks for the same delta forever.
 */
export async function fetchChanges(
  record: MachineRecord,
  projectId: string,
  since: number,
): Promise<BoardChanges> {
  const response = await call(
    record,
    paths.boardChanges(projectId, since, PAGE),
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
    // NOTE: Falls back to `since`, NOT to `head`. A malformed cursor that
    // became the head would silently mark this client caught up on changes
    // it never read; standing still costs one repeated request and loses
    // nothing.
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

/** Tick or untick one checklist box, against the revision on screen. */
export async function toggleChecklistItem(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  key: string,
  checked: boolean,
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, paths.itemChecklistItem(projectId, cardId, key), {
      method: "PATCH",
      // NOTE: Sent even though this endpoint treats it as optional: the user
      // is looking at a specific revision of this card, and a tick that
      // lands on a newer one is a decision they did not make.
      headers: { "if-match": String(revision) },
      body: JSON.stringify({ checked }),
    }),
  );
}

/**
 * Replace a card's checklist.
 *
 * NOTE: `If-Match` is required by the endpoint, and rightly: this rewrites a
 * list of decisions a human wrote, and landing it on a revision they never
 * read discards somebody else's edits without a word.
 */
export async function replaceChecklist(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  items: BoardChecklistDraft[],
  revision: number,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, paths.itemChecklist(projectId, cardId), {
      method: "PUT",
      headers: { "if-match": String(revision) },
      body: JSON.stringify({ items }),
    }),
  );
}

/**
 * Put a new card on the board.
 *
 * NOTE: Every optional field is OMITTED rather than sent as null. The
 * service reads a missing `columnKey` as "the board's first lane" and a
 * missing `categoryKey` as "no category"; a literal null is a value its
 * parser has to reject.
 *
 * `draft.tags` is handed to {@link readWrite} as well as sent. The board caps
 * tags and applies the cap silently, so comparing what was asked for against
 * what came back is the only way to tell somebody a tag did not land.
 */
export async function createCard(
  record: MachineRecord,
  projectId: string,
  draft: BoardCardDraft,
): Promise<BoardWrite> {
  return readWrite(
    await call(record, paths.items(projectId), {
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
 * A row this cannot read is DROPPED rather than defaulted. An activity line
 * is a claim about what somebody did ("decio set priority to Urgent"), and a
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
      // NOTE: Null is MEANINGFUL here (a retracted comment), so it is kept
      // rather than turned into an empty string the thread would render as a
      // blank.
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
 * NOTE: The cursor is the SERVICE's and travels back verbatim. It is keyed
 * on `(createdAt, id)` across two tables, so nothing here could compute the
 * next one, and a client that tried would page itself through the same
 * stretch of a conversation forever.
 */
export async function fetchActivity(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  cursor?: string | null,
): Promise<BoardActivityPage> {
  const response = await call(
    record,
    paths.itemActivity(
      projectId,
      cardId,
      cursor ? `cursor=${encodeURIComponent(cursor)}` : undefined,
    ),
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
 * No `If-Match`, unlike every card edit. A comment is an append: two people
 * writing at once both succeed, and neither has an earlier version to
 * overwrite.
 */
export async function createComment(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  text_: string,
): Promise<{ id: string }> {
  const response = await call(record, paths.itemComments(projectId, cardId), {
    method: "POST",
    body: JSON.stringify({ body: text_ }),
  });
  if (!response.ok)
    throw new Error(
      `Could not post that comment (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as { comment?: { id?: unknown } };
  const id = payload.comment?.id;
  if (!text(id)) throw new Error("The service returned an invalid comment.");
  return { id };
}

/**
 * Reword your own comment.
 *
 * @throws when the comment is someone else's (403), was deleted (409), or
 * the write fails.
 */
export async function editComment(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  commentId: string,
  text_: string,
): Promise<void> {
  const response = await call(
    record,
    paths.itemComment(projectId, cardId, commentId),
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

/**
 * Retract your own comment.
 *
 * A tombstone on the service, not a row removal.
 *
 * @throws when the comment is someone else's (403), or the delete fails.
 */
export async function deleteComment(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  commentId: string,
): Promise<void> {
  const response = await call(
    record,
    paths.itemComment(projectId, cardId, commentId),
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
 * `PUT`/`DELETE` rather than a toggle, so a retry after a lost response is
 * harmless. Both answer with the state that now holds, which is what the
 * caller renders, never the value it asked for.
 *
 * @returns the state the service says now holds.
 */
async function setFlag(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  path: "subscription" | "favorite",
  on: boolean,
  field: "subscribed" | "favorite",
  noun: string,
): Promise<boolean> {
  const response = await call(
    record,
    path === "subscription"
      ? paths.itemSubscription(projectId, cardId)
      : paths.itemFavorite(projectId, cardId),
    { method: on ? "PUT" : "DELETE" },
  );
  if (!response.ok)
    throw new Error(
      `Could not ${on ? "" : "un"}${noun} that card (HTTP ${response.status}). Try again.`,
    );
  const payload = (await body(response)) as Record<string, unknown>;
  return typeof payload[field] === "boolean" ? payload[field] : on;
}

/** Follow or unfollow a card; answers whether it is now followed. */
export const setSubscription = (
  record: MachineRecord,
  projectId: string,
  cardId: string,
  subscribed: boolean,
): Promise<boolean> =>
  setFlag(
    record,
    projectId,
    cardId,
    "subscription",
    subscribed,
    "subscribed",
    "follow",
  );

/** Star or unstar a card; answers whether it is now starred. */
export const setFavorite = (
  record: MachineRecord,
  projectId: string,
  cardId: string,
  favorite: boolean,
): Promise<boolean> =>
  setFlag(record, projectId, cardId, "favorite", favorite, "favorite", "star");

/**
 * Record a file this card refers to.
 *
 * METADATA ONLY. Nothing is uploaded and nothing is fetched: the service
 * stores the reference a caller states and hands it back untouched, so
 * opening one later is this machine's job.
 */
export async function attachFile(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  file: BoardAttachmentDraft,
): Promise<BoardAttachment> {
  const response = await call(
    record,
    paths.itemAttachments(projectId, cardId),
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

/** Remove one attachment record from a card. */
export async function detachFile(
  record: MachineRecord,
  projectId: string,
  cardId: string,
  attachmentId: string,
): Promise<void> {
  const response = await call(
    record,
    paths.itemAttachment(projectId, cardId, attachmentId),
    { method: "DELETE" },
  );
  if (!response.ok)
    throw new Error(
      `Could not remove that file (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Remove every card on a board, permanently.
 *
 * 404 means the SERVICE is older than this app, not that the board is gone:
 * `openBoard` answers 404 for a board you cannot see, and this app only
 * offers the action on a board it just read. "Cannot remove issues yet" is
 * the honest reading; "not found" would send someone looking for a board
 * that is right there.
 *
 * @param slug the project's slug, sent as the service's confirmation.
 */
export async function purgeIssues(
  record: MachineRecord,
  projectId: string,
  slug: string,
): Promise<{ deleted: number }> {
  const response = await call(record, paths.boardPurge(projectId), {
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
 * Archive one card: what "Delete" does on this board.
 *
 * `DELETE` on this route is a TOMBSTONE. The service stamps `archivedAt`,
 * bumps the revision and reserves a change `seq` for it, so the change feed
 * can carry the news. A row that disappeared could not be reported at all,
 * and a second machine would keep the card on screen forever.
 *
 * NOTE: Already archived is a SUCCESS, and the service says so with a plain
 * 200. A client that treated the second click as a failure would report a
 * button broken for having already done what it promised.
 */
export async function archiveCard(
  record: MachineRecord,
  projectId: string,
  cardId: string,
): Promise<void> {
  const response = await call(record, paths.item(projectId, cardId), {
    method: "DELETE",
  });
  if (response.status === 404)
    throw new Error("That card is no longer on this board.");
  if (!response.ok)
    throw new Error(
      `Could not delete that card (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Create one project on the account.
 *
 * NOTE: `POST /v1/sync/state/workspace`, the MACHINE surface.
 * `POST /v1/workspaces` is `sessionAuth` and refuses this app's credential
 * by design.
 *
 * A 404 is reported as an out-of-date SERVICE, not as a failure of the
 * request. This route is newer than some deployments, and "could not create
 * the project" would send somebody looking for the mistake in the name they
 * typed.
 *
 * @param input `path` is the PRIMARY source folder: sending it is what makes
 * the account record where this project lives on this machine, the same
 * field every other surface reads back as `project.path`. Omitted when the
 * project was created without folders: the column is `NOT NULL` on the
 * service's side, so an empty string would put a path nobody chose into the
 * one place clients look to find the code.
 * @returns the project, its `id` never null, unlike {@link Project}'s. The
 * caller opens its board with that id straight after, so a nullable id here
 * would push the check into the caller.
 * @throws when the service is too old, the slug is taken, the name is
 * refused, or the answer is malformed.
 */
export async function createProject(
  record: MachineRecord,
  input: { slug: string; name: string; path?: string },
): Promise<Project & { id: string }> {
  const response = await call(record, paths.syncWorkspace(), {
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
    throw new Error("The service returned an invalid project. Try again.");
  const row = payload.workspace as Record<string, unknown>;
  // NOTE: Validated as strictly as a listed row, and the id is REQUIRED here
  // unlike in `parseProjects`: a service that just created a project on
  // request has no older-shape excuse for not naming it, and the id is what
  // the next call (opening its board) is addressed by.
  if (!text(row.id) || !text(row.slug) || !text(row.name))
    throw new Error("The service returned an invalid project. Try again.");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    path: text(row.path) ? (row.path as string) : null,
    baseBranch: text(row.baseBranch) ? (row.baseBranch as string) : null,
  };
}

/**
 * Rename one project on the account, by CLOUD PROJECT ID.
 *
 * NOTE:
 * - `PATCH /v1/sync/state/workspace/:id`, the MACHINE surface.
 *   `PATCH /v1/workspaces/:id` is `sessionAuth` and refuses this app's
 *   credential by design.
 * - Keyed by ID, never by slug, and the two keys look alike: a uuid matches
 *   the service's slug shape (hex runs joined by hyphens). The service
 *   refuses the wrong keyspace with a 400 rather than a 404, which is the
 *   only reason mixing them up is a legible mistake. Do not "helpfully" pass
 *   a slug here.
 * - The name only. The service will not change a slug through any route, so
 *   nothing keyed by slug on this machine (the folder link above all) has to
 *   be rewritten after a rename.
 *
 * A 404 is reported as a project that is GONE rather than a request that
 * failed: the id was read from this account's own state, so the only way it
 * misses is a project deleted from somewhere else in the meantime.
 */
export async function renameProject(
  record: MachineRecord,
  id: string,
  name: string,
): Promise<void> {
  const response = await call(record, paths.syncWorkspaceById(id), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
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
 * Put the account's projects in this order, first to last (FE-32).
 *
 * ⚠️ `PUT /v1/sync/state/workspace-order`, by CLOUD ID like `renameProject`.
 * The service refuses the whole order with a 400 if any id is not one of this
 * account's live projects — most likely one deleted from another machine since
 * this list was read — so that is reported as a stale list, not a bad request.
 */
export async function reorderProjects(
  record: MachineRecord,
  ids: string[],
): Promise<void> {
  const response = await call(record, paths.syncWorkspaceOrder(), {
    method: "PUT",
    body: JSON.stringify({ ids }),
  });
  if (response.status === 400)
    throw new Error(
      "The project list changed somewhere else. Refresh and try again.",
    );
  if (!response.ok)
    throw new Error(
      `Could not save the project order (HTTP ${response.status}). Try again.`,
    );
}

/**
 * Delete one project from the account, by CLOUD PROJECT ID.
 *
 * ⚠️ `DELETE /v1/sync/state/workspace/:id`, the machine surface, and a real
 * delete: the service cascades the paths every machine reported for it. The
 * human surface (`DELETE /v1/workspaces/:id`) archives and can be restored —
 * this one cannot, which is why the only caller is behind a confirmation.
 *
 * ⚠️ Keyed by ID, the same keyspace as `renameProject` above. This route took
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
export async function deleteProject(
  record: MachineRecord,
  id: string,
): Promise<void> {
  const response = await call(record, paths.syncWorkspaceById(id), {
    method: "DELETE",
  });
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
  projectId: string,
  config: unknown,
): Promise<void> {
  const response = await call(record, paths.boardConfig(projectId), {
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
  projectId: string,
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
  const response = await call(record, paths.boardImport(projectId), {
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
  projectId: string,
  items: number,
  manifest: string,
): Promise<{ migratedAt: string | null; error?: string }> {
  const response = await call(record, paths.boardMigrated(projectId), {
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

/** What `GET /icon` answered (BE-18). */
type IconAnswer =
  | { kind: "same" }
  | { kind: "new"; key: string; type: string; bytes: Buffer }
  | { kind: "none" };

/**
 * The project's icon — its GitHub repo owner's avatar, which the SERVICE read
 * and keeps (BE-18). `held` is the key already on disk: a match is a 304 and
 * no bytes.
 *
 * ⚠️ From the control plane, never from GitHub: asking GitHub from here would
 * tell it which projects this person has open. 404 is "no icon" (no GitHub
 * repo, or a service older than the route), and the tile keeps its letter.
 */
export async function fetchIcon(
  record: MachineRecord,
  projectId: string,
  held: string | null,
): Promise<IconAnswer> {
  const response = await call(record, paths.boardIcon(projectId), {
    headers: held ? { "if-none-match": `"${held}"` } : {},
  });
  if (response.status === 304) return { kind: "same" };
  // ⚠️ Only a 404 is "no icon". A 5xx is the service having a bad minute, and
  // reading it as "none" would drop an icon that is still right.
  if (!response.ok && response.status !== 404) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Could not load the project icon (HTTP ${response.status}).`,
    );
  }
  const key = response.headers.get("x-icon-key");
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !key || !type.startsWith("image/")) {
    await response.body?.cancel().catch(() => {});
    return { kind: "none" };
  }
  // FE-78/D8: an icon is a small image. A body past the cap is refused, not
  // stored base64 in the cache.
  return {
    kind: "new",
    key,
    type,
    bytes: Buffer.from(await readCappedBytes(response, ICON_BODY_CAP)),
  };
}
