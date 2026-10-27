import {
  type BoardLabel,
  type BoardMember,
  type ChecklistSection,
  type ColumnRole,
  type Priority,
  STREAM_ROLES,
  type StreamRole,
} from "@lanework/protocol";

// The board's vocabulary and the shapes this app takes as the API states them
// come from @lanework/protocol, the contract the server implements, so a
// change there is a type error here rather than a silent default.
export {
  type BoardLabel,
  type BoardMember,
  CHECKLIST_SECTIONS,
  type ChecklistSection,
  type ColumnRole,
  type Priority,
  STREAM_ROLES,
  type StreamRole,
} from "@lanework/protocol";

export interface Workspace {
  /**
   * The cloud workspace id, the key every board call is addressed by.
   *
   * NOTE: Not the slug. Every board endpoint is `/v1/boards/:workspaceId/…`,
   * and so is a rename (`PATCH /v1/sync/state/workspace/:id`). It arrives on
   * `/v1/sync/state` (the machine surface); `/v1/workspaces` is `sessionAuth`
   * and refuses this app's credential by design.
   *
   * NOTE: Null against a control plane that predates the field. This app once
   * shipped a version that required it and refused every workspace a live
   * service returned. A missing id means "no board yet", never "no
   * workspace": the picker still works, the selection is still remembered by
   * slug, and only opening a board says what is wrong.
   */
  id: string | null;
  slug: string;
  name: string;
  /**
   * Where this machine keeps a checkout, or null.
   *
   * NOTE: Display and code execution only. A workspace with no path is a
   * complete, openable workspace (its cards live in the cloud), so nothing
   * about the board may gate on this being set.
   */
  path: string | null;
  baseBranch: string | null;
  /**
   * The project icon's key on the control plane, or null until the service
   * first reads one. The icon is the GitHub repo owner's avatar.
   *
   * The key names the bytes, so it is the cache key: a new value is a new
   * icon, and the same value is the file already on disk. Optional because a
   * service older than BE-18, and older test fixtures, omit it.
   */
  iconKey?: string | null;
  /**
   * Where the board lives; absent means `cloud`.
   *
   * A `local` board is in the SQLite store on this machine, and its `id` is
   * the local UUIDv7.
   */
  origin?: "cloud" | "local";
  /**
   * The cloud workspace id a synced local board moved to, or null/absent.
   *
   * A local board that was synced is read-only and points here (FE-52/D7a).
   */
  movedTo?: string | null;
}

/** What "Sync to cloud" answers. */
export interface LocalSyncResult {
  /** The local workspace id that was moved. */
  localId: string;
  /** The cloud workspace it now lives in. */
  cloudId: string;
  /** Cards uploaded. */
  cards: number;
  snapshot: WorkspaceSnapshot;
}

export interface WorkspaceSnapshot {
  workspaces: Workspace[];
  active: Workspace | null;
}

/** One lane of a board, as the cloud states it. */
export interface BoardColumn {
  key: string;
  name: string;
  role: ColumnRole | null;
  icon: string;
  tone: string;
  position: number;
}

export interface BoardCategory {
  key: string;
  name: string;
  prefix: string;
  tone: string;
}

// NOTE: `BoardLabel` (re-exported above) is the label VOCABULARY, NOT the list
// of tags in use. A card may carry a tag no label describes, and that board
// is normal, not broken: the chip is drawn neutral and the tag still filters.
// Treating the vocabulary as closed would hide tags the service stores.
//
// `BoardMember` (re-exported above) is somebody who can see this board. The
// directory exists because everything else names a person by id, and an id
// is not a face. `name` falls back to the id for an account that no longer
// exists. No email, by design: the service does not send one.

/**
 * Where an agent stopped on a card (BE-17).
 *
 * The `latest` of `GET /v1/boards/:id/items/:card/checkpoints`, as the issue
 * detail shows it.
 *
 * NOTE: `nextStep` may be an OLDER checkpoint's: the Stop hook writes after
 * every turn but never states one, so the server carries the last stated
 * step forward and `nextStepFrom` says whose it was.
 */
export interface CardCheckpoint {
  agent: string;
  host: string | null;
  createdAt: string;
  request: string | null;
  summary: string;
  nextStep: string | null;
  nextStepFrom: { agent: string; createdAt: string } | null;
  files: string[];
  git: {
    branch: string | null;
    head: string | null;
    wipRef: string | null;
  } | null;
}

/**
 * An agent that called the Lanework MCP about a card in the last few minutes.
 *
 * From `GET /v1/boards/:id/presence`. "Called recently", not "is running":
 * the server sees tool calls and nothing between them. This machine's own
 * agents are known exactly from their transcripts, so a row here that
 * duplicates one of those is hidden rather than shown twice.
 */
export interface BoardPresence {
  cardId: string;
  /** Resolvable against {@link BoardView | BoardView.members}. */
  userId: string;
  /** The OAuth client's slug: `claude-code`, `codex`, … */
  agent: string;
  /** The machine credential the call used; null over OAuth, which has none. */
  machineId: string | null;
  /** ISO timestamp of the last call the server recorded. */
  lastSeenAt: string;
}

/**
 * One entry in a card's history: the log and the thread as one sequence.
 *
 * NOTE: Merged BY THE SERVICE, not here. Two separately paged reads stitched
 * together on this side are correct only while both fit in one page; past
 * that, the seam silently drops whatever fell between them.
 */
export type BoardActivity =
  | {
      kind: "audit";
      id: string;
      seq: number;
      /** `created` | `patched` | `moved` | `checklist` | …, free text. */
      verb: string;
      actorKind: string;
      /** The account behind the actor, resolvable against `members`. */
      actorUserId: string | null;
      actorMachineId: string | null;
      /** `{ field: [before, after] }`, or whatever that verb records. */
      diff: Record<string, unknown> | null;
      at: string;
    }
  | {
      kind: "comment";
      id: string;
      authorKind: string;
      /** A user id, a machine id or an agent slug; read with `authorKind`. */
      authorRef: string;
      /** The account it was written for, whichever door it came through. */
      authorUserId: string | null;
      /** NULL for a retracted comment, which keeps its place in the thread. */
      body: string | null;
      at: string;
      /** Null while it stands as written. */
      editedAt: string | null;
      deletedAt: string | null;
    };

export interface BoardActivityPage {
  events: BoardActivity[];
  /** Null when this page is the end of the feed. */
  cursor: string | null;
}

/** One checklist row. The server derives `checked` from `checkedAt`. */
export interface BoardChecklistItem {
  key: string;
  section: ChecklistSection;
  text: string;
  checked: boolean;
  checkedAt: string | null;
  note: string | null;
  /**
   * The "pick ONE" group this row belongs to, or null.
   *
   * NOTE: Rows sharing a group are alternatives; only one may be ticked. The
   * review cards in this repo are written that way, so a screen that renders
   * every box as an independent checkbox misreads its own board.
   */
  group: string | null;
  /**
   * The stream (`W1`, …) a verify row proves, or null for the lead's own.
   *
   * NOTE: Optional because a service older than BE-19 never sends it; absent
   * and null both mean "the lead's". A rewrite must send it back, or the row
   * loses its stream.
   */
  stream?: string | null;
}

/**
 * One row on the way IN, as `PUT /checklist` takes it.
 *
 * NOTE: `key` is optional and stable once minted. Boxes are matched by key,
 * so a rewrite that sends back the keys it read keeps a human's ticks, even
 * on a reworded item. Dropping the keys silently un-ticks the card.
 */
export interface BoardChecklistDraft {
  key?: string | null;
  section?: ChecklistSection;
  text: string;
  checked?: boolean;
  note?: string | null;
  group?: string | null;
  /** See {@link BoardChecklistItem | BoardChecklistItem.stream}. */
  stream?: string | null;
}

/** The board's checklist limits, so a caller can refuse before the API does. */
export const CHECKLIST_LIMITS = {
  items: 200,
  text: 2000,
  key: 40,
  note: 4000,
} as const;

/**
 * Who a card is on, split by what kind of actor they are.
 *
 * Two lists rather than one tagged list, because that is how the board
 * addresses them: a `user` is a GitHub login and an `agent` is a Lanework
 * agent name. `agents[0]` is the dispatch role, not just the first one.
 */
export interface BoardAssignees {
  users: string[];
  agents: string[];
}

/** A card, trimmed to what this app renders and writes. */
export interface BoardCard {
  /**
   * When the card was taken off the board, on a change-feed row.
   *
   * A live read never carries one; a tombstone in `changes` does, and it is
   * the only way a client learns a card it is drawing is gone.
   */
  archivedAt?: string | null;
  id: string;
  /** The precondition an edit must carry. See {@link BoardConflict}. */
  revision: number;
  taskId: string | null;
  title: string;
  body: string;
  columnKey: string;
  categoryKey: string | null;
  priority: Priority | null;
  tags: string[];
  rank: string;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * The axis a hierarchy is drawn on: `issue` unless the board says otherwise.
   *
   * NOTE: Free text, not a union. The board's own config names the types, so
   * a hard-coded set would make this app refuse a card whose type is valid on
   * the board that sent it.
   */
  type: string;
  /** The card this one hangs under, or null for a top-level card. */
  parentId: string | null;
  estimate: number | null;
  dueAt: string | null;
  /**
   * The checklist, or NULL when this card was read from a list.
   *
   * NOTE: Null and `[]` are different answers. `GET /items` serializes without
   * `parts`, so a card from a board read has no checklist key at all. Reading
   * that as `[]` says "this card has no decisions" for a card that has seven.
   * A card with a checklist is read one at a time (`card` / `lookup`).
   */
  checklist: BoardChecklistItem[] | null;
  /**
   * How far through its checklist this card is, on EVERY read, list included.
   *
   * Not derivable from `checklist`, and not a duplicate of it. A list read
   * carries no checklist (see above); this is the cheap count the board sends
   * instead, so a lane can say `3/7` without shipping seven rows per card.
   * `{ done: 0, total: 0 }` means the card has no checklist; the API always
   * states this one. Null only for a service too old to send it.
   */
  checklistProgress: BoardChecklistProgress | null;
  /** Null for the same reason as `checklist`: absent from a list read. */
  assignees: BoardAssignees | null;
  /**
   * Who is following this card. Null on a list read, like `assignees`.
   *
   * User ids, resolved against `BoardView.members` like every other
   * person-shaped field, so one directory serves the whole screen instead of
   * each row carrying a copy of somebody's name.
   */
  subscribers: string[] | null;
  /**
   * Whether the person at this machine follows / has starred this card.
   *
   * These answer about the CALLER, not the card, so they are not derivable
   * from `subscribers` alone and the service sends them. Null on a list read
   * means "not asked", not "no".
   */
  subscribed: boolean | null;
  favorite: boolean | null;
  /** Live comments, tombstones excluded. Null on a list read. */
  commentCount: number | null;
  /**
   * The files this card refers to. Null on a list read.
   *
   * METADATA and a reference: the service stores and serves no bytes. A row
   * is a path or a URL somebody recorded, so opening one is this machine's
   * job, not a download.
   */
  attachments: BoardAttachment[] | null;
  /**
   * The card split into sub-agents' jobs (BE-19), `[]` when it has none.
   *
   * Optional: a service older than BE-19 omits it. Read absent as `[]`.
   */
  streams?: BoardStream[];
  /**
   * Who runs when, and what each is told, or null for a card without streams.
   *
   * Single-card reads only. When absent, {@link streamWaves} computes the
   * waves.
   */
  dispatch?: BoardDispatch | null;
}

/** One sub-agent's job on a card; `Stream` in @lanework/protocol, as parsed. */
export interface BoardStream {
  key: string;
  title: string;
  goal: string;
  role: StreamRole;
  /** Repo-relative paths; a trailing `/` is a directory. */
  owns: string[];
  reads: string[];
  /** Stream keys this one waits for. */
  dependsOn: string[];
  isolation: "worktree" | "shared";
  position: number;
}

export interface BoardDispatch {
  waves: string[][];
  briefs: Record<string, string>;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(nonEmpty) : [];

/**
 * A card's `streams` as the API sent them, in `position` order, or `[]`.
 *
 * Defensive like every other card parser: a row without a key is dropped (a
 * key is what checklist rows and waves point at), and anything else unknown
 * is defaulted rather than refused.
 */
export function parseStreams(value: unknown): BoardStream[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry, index): BoardStream[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (!nonEmpty(row.key)) return [];
      return [
        {
          key: row.key,
          title: nonEmpty(row.title) ? row.title : row.key,
          goal: typeof row.goal === "string" ? row.goal : "",
          role: STREAM_ROLES.includes(row.role as StreamRole)
            ? (row.role as StreamRole)
            : "implement",
          owns: stringList(row.owns),
          reads: stringList(row.reads),
          dependsOn: stringList(row.dependsOn),
          isolation: row.isolation === "shared" ? "shared" : "worktree",
          position:
            typeof row.position === "number" && Number.isFinite(row.position)
              ? row.position
              : index,
        },
      ];
    })
    .sort((a, b) => a.position - b.position);
}

/** A single-card read's `dispatch`, or null when absent or malformed. */
export function parseDispatch(value: unknown): BoardDispatch | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.waves)) return null;
  const waves = row.waves
    .map((wave) => stringList(wave))
    .filter((wave) => wave.length > 0);
  const briefs: Record<string, string> = {};
  if (row.briefs && typeof row.briefs === "object")
    for (const [key, brief] of Object.entries(row.briefs))
      if (typeof brief === "string") briefs[key] = brief;
  return { waves, briefs };
}

/** A checklist row's `stream`: a non-empty key, or null. */
export function parseItemStream(value: unknown): string | null {
  return nonEmpty(value) ? value : null;
}

/**
 * The streams in dependency waves, each stream drawn exactly once.
 *
 * Wave 0 depends on nothing, each later wave only on earlier ones. The
 * server's `dispatch.waves` wins when it is there. A dependency on a key the
 * card does not have is ignored. A cycle (the API refuses one, an old row
 * might not) lands in one last wave rather than looping or vanishing.
 */
export function streamWaves(
  streams: BoardStream[],
  dispatch?: BoardDispatch | null,
): BoardStream[][] {
  const byKey = new Map(streams.map((stream) => [stream.key, stream]));
  if (dispatch?.waves.length) {
    const placed = new Set<string>();
    const waves = dispatch.waves
      .map((wave) =>
        wave.flatMap((key) => {
          const stream = byKey.get(key);
          if (!stream || placed.has(key)) return [];
          placed.add(key);
          return [stream];
        }),
      )
      .filter((wave) => wave.length > 0);
    const rest = streams.filter((stream) => !placed.has(stream.key));
    return rest.length ? [...waves, rest] : waves;
  }
  const waves: BoardStream[][] = [];
  const done = new Set<string>();
  let left = streams;
  while (left.length) {
    const ready = left.filter((stream) =>
      stream.dependsOn.every((key) => done.has(key) || !byKey.has(key)),
    );
    if (!ready.length) {
      waves.push(left);
      break;
    }
    waves.push(ready);
    for (const stream of ready) done.add(stream.key);
    left = left.filter((stream) => !done.has(stream.key));
  }
  return waves;
}

/** A file reference on its way to a card. */
export interface BoardAttachmentDraft {
  name: string;
  reference: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

/** A file a card points at. The service never holds its content. */
export interface BoardAttachment {
  id: string;
  name: string;
  /** A repo-relative path or a URL, exactly as it was recorded. */
  reference: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceKind: string | null;
}

/** A card's checklist as one fraction. */
export interface BoardChecklistProgress {
  done: number;
  total: number;
}

/**
 * The fields a person may edit from this app.
 *
 * NOTE: NOT `Partial<BoardCard>`. `revision`, `rank`, `taskId` and the
 * timestamps are the server's to set, and a patch type that could name them
 * is one a caller will eventually fill in. An absent key means "leave it";
 * `null` on a nullable field means "clear it".
 */
export interface BoardCardPatch {
  title?: string;
  body?: string;
  priority?: Priority | null;
  tags?: string[];
  categoryKey?: string | null;
  /**
   * Who the card is on, REPLACED and never merged, like `tags`.
   *
   * NOTE: Both lists travel together even when only one changes. The service
   * replaces the whole set, so sending `{ users: [...] }` alone would clear
   * every agent assignment as a side effect of naming a person.
   */
  assignees?: BoardAssignees;
  /** The card this one hangs under; `null` promotes it to the top level. */
  parentId?: string | null;
  dueAt?: string | null;
  estimate?: number | null;
  type?: string;
}

/**
 * Where a card lands among its neighbours; absent means "append to the lane".
 *
 * NOTE: Stated as a NEIGHBOUR, never as a rank string. The board generates
 * the fractional index itself. Two clients computing their own would
 * eventually pick the same one, while `after`/`before` is a request the
 * server can always satisfy.
 */
export type BoardPlacement = { after: string } | { before: string };

export interface BoardView {
  workspaceId: string;
  columns: BoardColumn[];
  categories: BoardCategory[];
  /** The label vocabulary. Empty is normal; see {@link BoardLabel}. */
  labels: BoardLabel[];
  /** Everyone who can see this board, for turning ids into faces. */
  members: BoardMember[];
  cards: BoardCard[];
  /** True when this board has been migrated and the cloud owns its cards. */
  migrated: boolean;
  /**
   * When this data was read, and whether it came from the last good copy.
   *
   * NOTE: The UI must say so. "Nothing here" and "I could not ask" look the
   * same on screen, and a developer who trusts an empty board starts typing a
   * card that already exists.
   */
  fetchedAt: string;
  stale: boolean;
  /**
   * The service's counts for the query this board was read under.
   *
   * Absent from a service older than `/stats`; then the loaded cards ARE the
   * board, and counting them is right. Optional also because a saved copy
   * written before the field reads back without it.
   */
  stats?: BoardStats | null;
  /** Every live card on the board, unfiltered: the rail's number. */
  total?: number | null;
  /** {@link boardQueryKey} of the query the groups below were read under. */
  query?: string;
  /**
   * Each group read so far, by key, and where its next page starts.
   *
   * A key is a lane, a priority or a category. `cursor: null` means the group
   * is complete. Absent when the whole board was read in one go.
   */
  groups?: Record<string, { cursor: string | null; limit: number }>;
  /**
   * The change head the read started from. Absent from a whole-board read.
   *
   * The LOWEST any group page reported, so the feed replays a change that
   * landed between two of them rather than skipping it.
   */
  head?: number | null;
}

/** What a board screen groups by. The lanes always group by status. */
export type BoardGroupBy = "status" | "category" | "priority";

/**
 * What a board is read under: its grouping and its filters.
 *
 * The service applies the filters to every group's query and to the counts.
 */
export interface BoardQuery {
  groupBy: BoardGroupBy;
  filters: {
    status?: string;
    category?: string;
    priority?: string;
    tag?: string;
  };
}

export const DEFAULT_BOARD_QUERY: BoardQuery = {
  groupBy: "status",
  filters: {},
};

/** A stable key for a query, so two equal ones compare equal. */
export function boardQueryKey(query: BoardQuery): string {
  const { status, category, priority, tag } = query.filters;
  return JSON.stringify([query.groupBy, status, category, priority, tag]);
}

/** `GET /v1/boards/:id/stats`. `"none"` keys the cards with no value. */
export interface BoardStats {
  total: number;
  byColumn: Record<string, number>;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
}

/** The next page of one group. */
export interface BoardGroupPage {
  cards: BoardCard[];
  cursor: string | null;
  /** The board's change head when this page was read, if the service said. */
  head: number | null;
}

/**
 * What the server said when an edit lost a race.
 *
 * It carries the card as it stands NOW, because the API's 409 does. A
 * conflict dialog that could only say "you are out of date" would send the
 * user to go and look; this one can show both sides.
 */
export interface BoardConflict {
  kind: "conflict";
  message: string;
  current: BoardCard;
}

/**
 * A card as somebody composed it, before the board has one.
 *
 * NOTE: NOT `Partial<BoardCard>`. A card carries an id, a revision, a rank
 * and a task id, all of them the board's to mint, and a draft that borrowed
 * that shape would invite a caller to send one back.
 *
 * An absent `columnKey` means "the board's first lane", the service's own
 * default rather than a guess made here. Sending a lane the composer never
 * showed would put cards somewhere nobody chose.
 */
export interface BoardCardDraft {
  title: string;
  body?: string | null;
  categoryKey?: string | null;
  columnKey?: string | null;
  priority?: BoardCard["priority"];
  /** Capped and normalized by the board; the write reports what it dropped. */
  tags?: string[];
}

/**
 * The words of a search, folded the way the service's FTS index folds them.
 *
 * Lower case, diacritics dropped, split on anything that is not a letter or
 * a digit: "Dự án FE-1" is `["du", "an", "fe", "1"]`.
 */
function searchTokens(raw: string): string[] {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether a card answers a search.
 *
 * Every word must be the START of a word in its title or task id. That is
 * the rule the service's prefix query applies, so the palette's instant
 * local answer and the service's agree.
 */
export function matchesSearch(
  card: Pick<BoardCard, "title" | "taskId">,
  query: string,
): boolean {
  const wanted = searchTokens(query);
  if (!wanted.length) return false;
  const have = searchTokens(`${card.title} ${card.taskId ?? ""}`);
  return wanted.every((word) => have.some((token) => token.startsWith(word)));
}

/**
 * The board's own tag rule, mirrored.
 *
 * NOTE: Copied from the API's `normalizeTag`, and it has to stay in step. It
 * lives here rather than in main because both sides need the same answer:
 * main compares what a write asked for against what came back to name a
 * dropped tag, and the renderer shows the chip a tag is ABOUT to become. Two
 * copies here would eventually disagree, and the screen would promise a tag
 * the board does not store.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

export type BoardWrite =
  /**
   * A write that landed, with the tags the board dropped from it.
   *
   * `droppedTags` rides along on SUCCESS, the only place it is useful. The
   * board caps tags (3 by default) silently, so a write that "worked" is the
   * moment a user needs telling that two of the five tags they typed are not
   * on the card. Empty on every write that named no tags.
   */
  | { kind: "ok"; card: BoardCard; droppedTags: string[] }
  | BoardConflict
  | { kind: "error"; message: string };

/**
 * What changed on a board since a cursor.
 *
 * NOTE: `nextSince` is the cursor to send back, NOT `since + 1` and not the
 * last card's seq. The feed is monotonic but not contiguous, and board-level
 * events carry no card to advance past, so a client that derived its own
 * cursor would ask for the same delta forever.
 */
export interface BoardChanges {
  /** The board's current head, for "am I caught up?" without another read. */
  head: number;
  nextSince: number;
  hasMore: boolean;
  /**
  /**
   * The cards that changed.
   *
   * Read from a list, so their `checklist` and `assignees` are null; see
   * {@link BoardCard}.
   */
  cards: BoardCard[];
  /**
   * Board-level changes, which carry no card: lanes or categories were edited.
   *
   * A client seeing one re-reads the whole board rather than patching it.
   */
  events: { seq: number; verb: string }[];
}

/**
 * What an import would do, before it does any of it.
 *
 * Read from the FOLDER on this machine, not from the cloud. Every number is
 * about files not migrated yet, which is why the screen that shows it is the
 * one that says a board has no cards.
 */
export interface ImportPreview {
  workspaceId: string;
  /** The folder these numbers came from, or null when none is linked. */
  folder: string | null;
  cards: number;
  byColumn: Record<string, number>;
  checklistItems: number;
  withTaskId: number;
  duplicateTaskIds: string[];
  /** Ticked boxes whose moment has to be inferred, never a fact. */
  inferredCheckedAt: number;
  /** Options belonging to a "pick ONE" group, which travel as a group. */
  groups: number;
  /** Items decided against: unchecked rows that keep the marker. */
  dropped: number;
  attachments: number;
  auditEventsLeftBehind: number | null;
  /**
   * Why this project must not be migrated from this app, or null.
   *
   * A refusal with a reason, not an error. A repo with its own
   * `.agents/reviews/config.json` can rename lanes and re-map statuses, and
   * this app reads the defaults only, so importing it from here would file
   * cards into lanes the board does not have.
   */
  blocked: string | null;
  problems: { path: string; reason: string }[];
}

export interface ImportReport {
  summary: Record<string, number>;
  receipts: {
    ref: string;
    status: string;
    taskId?: string | null;
    error?: string;
  }[];
  /** Set once the cutover has been sealed against a verified count. */
  migratedAt?: string | null;
  /** Set when the run stopped; records already accepted stay on the board. */
  error?: string | null;
}

/**
 * One review card as read from a FILE, without opening its body.
 *
 * NOTE: Front matter and the first heading, nothing else. What a checklist
 * item is gets defined in one place, `scanTaskBlocks`/`parseDoc` in the
 * Lanework board, and a second reader of a card's BODY in this app is how
 * the two start disagreeing on a hand-edited card. Front matter is a fixed
 * set of `key: value` lines no parser has an opinion about, so reading it
 * cannot drift.
 */
export interface LocalFolderCard {
  /** Path relative to the folder, so it reads like the file it came from. */
  ref: string;
  taskId: string | null;
  title: string;
  status: string | null;
  category: string | null;
  createdAt: string | null;
}

/**
 * What a folder on this machine turned out to hold.
 *
 * NOT a board: no checklist progress and no card body. It answers "did I
 * point at the right project, and what is in it", so the user can decide
 * whether to migrate. Rendering cards from files is a different feature with
 * a different cost (it needs the board's own parsers, in another repo).
 */
export interface LocalFolderSummary {
  path: string;
  /** Where the cards were found, relative to `path`, or null when none. */
  reviewRoot: string | null;
  cards: number;
  /** Card counts by front-matter `status`, e.g. `{ done: 9, todo: 5 }`. */
  byStatus: Record<string, number>;
  /** Card counts by front-matter `category`, e.g. `{ backend: 6 }`. */
  byCategory: Record<string, number>;
  /** The newest `created_at` seen, or null when no card carries one. */
  newest: string | null;
  /** Files under the review root this reader could not read at all. */
  unreadable: number;
  /**
   * True when the scan stopped at its limit: every count above is a FLOOR.
   *
   * Reported rather than swallowed. A cap that silently truncates makes a big
   * repo look small, and "you have 2000 cards" would then be the one number
   * on screen that is wrong in the direction that matters.
   */
  capped: boolean;
  /** True when the folder has no `.agents` directory: a different sentence. */
  looksUnrelated: boolean;
  /** The first few cards, for a "is this the right project" glance. */
  sample: LocalFolderCard[];
}

/**
 * Whether this workspace has a folder on this machine, and what is in it.
 *
 * `missing` is its own case rather than falling back to `none`. A linked
 * folder that has since moved or been deleted is worth saying: "no folder
 * linked" would invite the user to link it again and be surprised.
 */
export type LocalFolderState =
  | { kind: "none" }
  /**
   * A linked project: the PRIMARY folder's summary, the rest by path only.
   *
   * A project can be assembled from several folders (the create dialog asks
   * for that), but only one holds the `.agents/reviews` a migration reads.
   * Reading all of them would produce a count that belongs to no folder.
   */
  | { kind: "linked"; summary: LocalFolderSummary; others: string[] }
  | { kind: "missing"; path: string };

/**
 * A folder the user just chose in the OS chooser, on its way back to a window.
 *
 * NOTE: `id` is what travels BACK to main, never `path`. The chooser runs in
 * main and mints an id per chosen folder; `path` rides along so the dialog
 * can show what was picked. A create call that took paths would be a channel
 * that reads any folder the renderer names; see {@link DesktopFolderApi}.
 */
export interface PickedFolder {
  id: string;
  path: string;
  /** The last path segment, which is what a list of folders reads by. */
  name: string;
}

export const workspaceChannels = {
  load: "workspaces:load",
  select: "workspaces:select",
  icon: "workspaces:icon",
  board: "workspaces:board",
  more: "workspaces:board:more",
  stats: "workspaces:board:stats",
  presence: "workspaces:board:presence",
  checkpoint: "workspaces:board:checkpoint",
  move: "workspaces:board:move",
  toggle: "workspaces:board:toggle",
  setChecklist: "workspaces:board:checklist",
  create: "workspaces:board:create",
  archive: "workspaces:board:archive",
  purge: "workspaces:board:purge",
  importPreview: "workspaces:import:preview",
  importRun: "workspaces:import:run",
  importSeal: "workspaces:import:seal",
  update: "workspaces:board:update",
  activity: "workspaces:board:activity",
  comment: "workspaces:board:comment",
  commentEdit: "workspaces:board:comment:edit",
  commentDelete: "workspaces:board:comment:delete",
  subscribe: "workspaces:board:subscribe",
  favorite: "workspaces:board:favorite",
  attach: "workspaces:board:attach",
  detach: "workspaces:board:detach",
  card: "workspaces:board:card",
  lookup: "workspaces:board:lookup",
  search: "workspaces:board:search",
  changes: "workspaces:board:changes",
  createWorkspace: "workspaces:new",
  renameWorkspace: "workspaces:rename",
  reorderWorkspaces: "workspaces:reorder",
  deleteWorkspace: "workspaces:delete",
  folderState: "workspaces:folder:state",
  folderPick: "workspaces:folder:pick",
  folderChoose: "workspaces:folder:choose",
  folderList: "workspaces:folder:list",
  folderLink: "workspaces:folder:link",
  folderForget: "workspaces:folder:forget",
  folderReveal: "workspaces:folder:reveal",
  /** Move a local board to the cloud, in one click (FE-52/D7a). */
  syncToCloud: "workspaces:local:sync",
  /**
   * Main → renderer: the local store changed under this window.
   *
   * The offline MCP or the hook wrote. Payload: the local workspace ids that
   * changed, or empty for "re-read everything local".
   */
  localChanged: "workspaces:local:changed",
} as const;

export interface DesktopBoardApi {
  /**
   * A board, read one group at a time under `query`.
   *
   * Answers the counts and the first page of every group the query draws.
   */
  load: (workspaceId: string, query?: BoardQuery) => Promise<BoardView>;
  /** The next page of one group, from where the last one stopped. */
  more: (
    workspaceId: string,
    query: BoardQuery,
    group: string,
    cursor: string,
  ) => Promise<BoardGroupPage>;
  /** The counts again, after something changed. Null from an older service. */
  stats: (
    workspaceId: string,
    query: BoardQuery,
  ) => Promise<{ stats: BoardStats; total: number } | null>;
  /**
   * The agents working on the board's cards, from every machine.
   *
   * Empty from a service older than `/presence`.
   */
  presence: (workspaceId: string) => Promise<BoardPresence[]>;
  /**
   * Where the last agent on this card stopped, or null.
   *
   * Null when none is left, or from a service older than BE-17.
   */
  checkpoint: (
    workspaceId: string,
    cardId: string,
  ) => Promise<CardCheckpoint | null>;
  /**
   * One card WITH its checklist and assignees, by id.
   *
   * A second read, not a redundant one: `load` reads the board through
   * `GET /items`, which serializes without parts. Every screen that shows a
   * card's decisions has to ask for that card by itself.
   */
  card: (workspaceId: string, cardId: string) => Promise<BoardCard>;
  /**
   * The same card, addressed the way a human says it: `FE-06`.
   *
   * Answers null for "no such card", a real answer rather than a failure: a
   * deep link can name a task id that was never minted, and the board's route
   * makes that a 404 so it cannot be confused with a failed read.
   */
  lookup: (workspaceId: string, taskId: string) => Promise<BoardCard | null>;
  /**
   * Cards whose title or task id answer `query`, at most 20.
   *
   * From the SERVICE, not only the cards this window has loaded.
   */
  search: (workspaceId: string, query: string) => Promise<BoardCard[]>;
  /**
   * Edit a card, against the revision the caller is looking at.
   *
   * NOTE: `revision` is not optional. The endpoint answers 428 without
   * `If-Match`, and a required precondition is what stops an edit from
   * silently landing on somebody else's newer card.
   */
  update: (
    workspaceId: string,
    cardId: string,
    patch: BoardCardPatch,
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Move a card between lanes, within a lane, or both.
   *
   * `columnKey: null` means "stay in this lane", a pure reorder. One atomic
   * request either way: a move that changed the lane and then the position
   * would be two writes a second client could interleave with.
   */
  move: (
    workspaceId: string,
    cardId: string,
    columnKey: string | null,
    placement?: BoardPlacement,
  ) => Promise<BoardWrite>;
  /** What changed since `since`; pass 0 for a first read. */
  changes: (workspaceId: string, since: number) => Promise<BoardChanges>;
  toggle: (
    workspaceId: string,
    cardId: string,
    key: string,
    checked: boolean,
    /** The revision the user is looking at, sent as `If-Match`. */
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Replace a card's whole checklist: creates, edits, reorders and deletes.
   *
   * A REPLACE, not row operations, because that is what the board offers: a
   * checklist is an ordered document, and "delete row 3" is ambiguous the
   * moment a second person is editing. Send back the keys you read and ticked
   * boxes survive the rewrite.
   */
  setChecklist: (
    workspaceId: string,
    cardId: string,
    items: BoardChecklistDraft[],
    revision: number,
  ) => Promise<BoardWrite>;
  /**
   * Put a new card on the board.
   *
   * A DRAFT, not a title. The board mints a card's issue key from its
   * CATEGORY (`taskId` stays null without one), and a card with no key is
   * unreachable by ⌘K, cannot be deep-linked, and is unnamed in every list.
   * Every field is one `POST /items` already accepts; only `title` is
   * required, and the board picks its first lane when `columnKey` is absent.
   */
  create: (workspaceId: string, draft: BoardCardDraft) => Promise<BoardWrite>;
  /**
   * Take a card off the board.
   *
   * The service ARCHIVES rather than deletes, leaving a tombstone with its own
   * `seq`: a row that simply vanished could not be reported by the change
   * feed, and every other client holding that card would keep drawing it.
   * Hence `archive` here, and "Delete" on screen, where the word has to mean
   * what a person meant by right-clicking a card.
   *
   * Answers nothing. The board is re-read afterwards rather than patched: an
   * archive changes every lane's ranks and counts, and a client that spliced
   * one row out of its own copy would be guessing at the rest.
   */
  archive: (workspaceId: string, cardId: string) => Promise<void>;
  /**
   * Permanently remove EVERY card on a board.
   *
   * NOTE: A real delete, unlike `archive`: cards, checklists, comments and
   * their history go, and nothing in this app can bring them back. The
   * project, its lanes, categories and members stay, and the migration seal
   * is lifted.
   *
   * Takes the SLUG as well as the id, and the service checks it: the id says
   * which board, the slug says the person meant that one.
   */
  purge: (workspaceId: string, slug: string) => Promise<{ deleted: number }>;
  /**
   * One page of a card's history and thread, oldest first.
   *
   * NOTE: `cursor` is the service's, echoed back verbatim. It is keyed on
   * `(createdAt, id)` across two tables, so nothing on this side can derive
   * the next one from what it just read.
   */
  activity: (
    workspaceId: string,
    cardId: string,
    cursor?: string | null,
  ) => Promise<BoardActivityPage>;
  /**
   * Say something on a card. Answers the new comment's id.
   *
   * No `revision` and no `If-Match`, unlike every card edit. A comment is an
   * append: two people writing at once both succeed, and there is no earlier
   * version for either to overwrite.
   */
  comment: (
    workspaceId: string,
    cardId: string,
    body: string,
  ) => Promise<{ id: string }>;
  /** Reword your own comment. The service refuses anybody else's. */
  editComment: (
    workspaceId: string,
    cardId: string,
    commentId: string,
    body: string,
  ) => Promise<void>;
  /**
   * Retract your own comment.
   *
   * The service keeps a TOMBSTONE: the row keeps its place with its body
   * gone, so a thread that referred to it still reads as a conversation.
   */
  deleteComment: (
    workspaceId: string,
    cardId: string,
    commentId: string,
  ) => Promise<void>;
  /**
   * Follow or unfollow a card, and star or unstar it.
   *
   * Idempotent and with no revision, because neither edits the card: both
   * are facts about the person at this machine. Calling either twice with the
   * same value gives the state the caller asked for, not an error.
   */
  subscribe: (
    workspaceId: string,
    cardId: string,
    subscribed: boolean,
  ) => Promise<boolean>;
  favorite: (
    workspaceId: string,
    cardId: string,
    favorite: boolean,
  ) => Promise<boolean>;
  /**
   * Record a file this card refers to: a path or a URL, never bytes.
   *
   * Nothing is uploaded. The service stores metadata and a reference and
   * hands it back untouched; hosting content is a separate feature with its
   * own storage, quota and signed URLs.
   */
  attach: (
    workspaceId: string,
    cardId: string,
    file: BoardAttachmentDraft,
  ) => Promise<BoardAttachment>;
  detach: (
    workspaceId: string,
    cardId: string,
    attachmentId: string,
  ) => Promise<void>;
  importPreview: (workspaceId: string) => Promise<ImportPreview>;
  importRun: (workspaceId: string) => Promise<ImportReport>;
  /**
   * Hand the board over: the cloud owns these cards from now on.
   *
   * A SECOND call, after `importRun`. The cutover puts every local writer
   * into read-only, so it is taken with the import's receipts already on
   * screen. One button doing both would change a board's source of truth
   * while somebody was still reading whether it worked.
   */
  importSeal: (workspaceId: string) => Promise<ImportReport>;
}

/**
 * The folder on this machine a workspace's cards still live in.
 *
 * Every method is keyed by SLUG, not by the cloud workspace id. The id is
 * absent exactly when this surface matters most: a service that predates the
 * field sends none, and that is the screen that says the board cannot be
 * opened. A slug is also STABLE: no route on the service can change one (the
 * rename validator refuses the field), so a rename cannot strand a link.
 *
 * NOTE: No method takes a PATH from the renderer. `pick` opens the OS folder
 * chooser in main, so the only paths this app reads are ones a human
 * selected or ones it wrote down itself.
 */
export interface DesktopFolderApi {
  state: (slug: string) => Promise<LocalFolderState>;
  /**
   * Open the OS chooser and answer with what was picked, many folders at once.
   *
   * Bound to no workspace, because the main caller is the create dialog: the
   * folders are chosen BEFORE their project exists. Nothing is written down
   * here; `create` spends the ids.
   */
  choose: () => Promise<PickedFolder[]>;
  /**
   * The folders linked to a workspace, primary first, as addressable ids.
   *
   * The same shape `choose` answers with, so an editor works on ONE list
   * (what is linked plus what was just picked) and hands it all back to
   * `link`. Ids for folders this app already holds are minted here, so
   * nothing has to accept a path to keep one.
   */
  list: (slug: string) => Promise<PickedFolder[]>;
  /**
   * Replace a workspace's folders with exactly these, primary first.
   *
   * A REPLACE: stating the whole set is what makes remove and reorder
   * expressible. An empty list unlinks the workspace, as `forget` does.
   */
  link: (slug: string, folders: string[]) => Promise<LocalFolderState>;
  pick: (slug: string) => Promise<LocalFolderState>;
  forget: (slug: string) => Promise<LocalFolderState>;
  reveal: (slug: string) => Promise<void>;
}

export interface DesktopWorkspacesApi {
  load: () => Promise<WorkspaceSnapshot>;
  select: (id: string) => Promise<WorkspaceSnapshot>;
  /**
   * A project's icon as a `data:` URL, or null for the letter tile.
   *
   * Pass the `iconKey` the list gave; main draws from its disk cache first.
   */
  icon: (workspaceId: string, iconKey: string | null) => Promise<string | null>;
  /**
   * Create a project on the account and open it.
   *
   * Takes the NAME a human typed, not a slug. Main derives the slug
   * (`slug.ts`) because the service refuses to, and asking a user for a
   * url-safe key is asking them to do a computer's job.
   *
   * NOTE: `folders` are {@link PickedFolder} IDS, in order, and the first is
   * the primary: the folder every single-folder surface (the migration, "open
   * in file manager") means. Ids rather than paths, so this channel cannot be
   * asked to link a folder the user never chose.
   */
  create: (name: string, folders?: string[]) => Promise<WorkspaceSnapshot>;
  /**
   * Rename a project on the account, by CLOUD WORKSPACE ID.
   *
   * Only the display name changes. The SLUG is immutable service-wide (the
   * rename validator refuses the field rather than ignoring it), so the
   * folder link, the remembered selection and every other slug-keyed row
   * survive. The rename is on the account, for every machine, not a local
   * one.
   *
   * A workspace whose `id` is null cannot be renamed: a service too old to
   * send an id has no route for it. The screen says so rather than calling.
   */
  rename: (id: string, name: string) => Promise<WorkspaceSnapshot>;
  /**
   * Put the account's projects in this order, first to last, by CLOUD ID.
   *
   * Answers the list as the service now orders it. The switcher and ⌘1…⌘9
   * follow that order.
   */
  reorder: (ids: string[]) => Promise<WorkspaceSnapshot>;
  /**
   * Delete a project from the ACCOUNT, and answer with what is left.
   *
   * NOTE: Not "remove it from this machine": the service deletes the row and
   * cascades the paths every machine reported for it. It cannot be undone
   * from here (the human surface archives, this one deletes), so the only
   * caller is behind a confirmation that says so.
   *
   * Takes BOTH keys. The machine surface deletes by cloud id and refuses a
   * slug with a 400; it moved off the slug because a uuid matches its slug
   * shape, and the mix-up answered "200, deleted nothing". The folder link
   * this machine drops afterwards is still keyed by slug.
   *
   * So a project with NO cloud id cannot be deleted from here, and the button
   * is disabled with that reason on it. That is a service older than the `id`
   * field, the same state that stops the project's board from opening.
   */
  remove: (id: string, slug: string) => Promise<WorkspaceSnapshot>;
  /**
   * Upload a LOCAL board to the signed-in account (FE-52/D7a).
   *
   * Keeps task ids, checklists and lanes, then makes the local copy read-only
   * and points it at the cloud board. Refused while not signed in.
   */
  syncToCloud: (localId: string) => Promise<LocalSyncResult>;
  /** The local store changed from outside this window (MCP, hook). */
  onLocalChange: (listener: (workspaceIds: string[]) => void) => () => void;
  board: DesktopBoardApi;
  folder: DesktopFolderApi;
}
