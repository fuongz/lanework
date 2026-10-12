// The board: `/v1/boards/*`. A human session OR a machine credential reaches
// it (`actorAuth`). Derived from the server's `routes/boards.ts` and the
// serializers it calls (`serializeItem`, `serializeBoard`, …).
//
// ⚠️ A board is addressed by its workspace UUID, never its slug. A 404 means
// "no such board, or not yours" — the API never says which.

import type { IsoDate } from "./common";

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const WORK_ITEM_TYPES = ["epic", "issue", "task"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CHECKLIST_SECTIONS = ["decisions", "verify"] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

export const COLUMN_ROLES = [
  "intake",
  "start",
  "active",
  "done",
  "archive",
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** What a caller may ask for. `blocked_by` is input only; it is stored flipped. */
export const LINK_TYPES = [
  "blocks",
  "blocked_by",
  "relates",
  "duplicates",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const STREAM_ROLES = ["research", "implement", "test"] as const;
export type StreamRole = (typeof STREAM_ROLES)[number];

export const STREAM_ISOLATIONS = ["worktree", "shared"] as const;
export type StreamIsolation = (typeof STREAM_ISOLATIONS)[number];

/** Who did something: a signed-in human, a machine credential, or an agent. */
export type ActorKind = "user" | "machine" | "agent";

/** Page size the list routes serve by default, and their ceiling. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// ── Board config ────────────────────────────────────────────────────────────

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
  /** e.g. `BE`. */
  prefix: string;
  /** e.g. `{prefix}-{seq}`. */
  format: string;
  pad: number;
  tone: string;
  position: number;
}

/** One entry of the label vocabulary. `key` is a normalized tag. */
export interface BoardLabel {
  key: string;
  name: string;
  tone: string;
  position: number;
}

/** How many tags a card may carry (`0` = uncapped), and which (empty = any). */
export interface TagPolicy {
  max: number;
  allowed: string[];
}

/** A member as every avatar surface reads it — no email, by design. */
export interface BoardMember {
  userId: string;
  name: string;
  image: string | null;
  role: string;
}

/** `GET /v1/boards/:workspaceId/config` → `{ board }`. */
export interface BoardConfig {
  workspaceId: string;
  /** The caller's membership; only `owner` may write the config. */
  role: string;
  changeSeq: number;
  /** When this board became the source of truth for its repo, or null. */
  migratedAt: IsoDate | null;
  tags: TagPolicy;
  columns: BoardColumn[];
  categories: BoardCategory[];
  labels: BoardLabel[];
  members: BoardMember[];
}

export interface BoardConfigResponse {
  board: BoardConfig;
}

/** `PUT /v1/boards/:workspaceId/config` — replace lanes and categories. Owner only. */
export interface BoardConfigRequest {
  columns: BoardColumn[];
  categories: BoardCategory[];
  tags: TagPolicy;
  /** Absent leaves the vocabulary as it is; `[]` clears it. */
  labels?: BoardLabel[];
  /** Removed lane key → lane its cards move to. Required for a non-empty lane. */
  reassign?: Record<string, string>;
}

export interface BoardConfigPutResponse {
  board: BoardConfig | null;
  seq: number;
}

/** 409 from `PUT /config` when a removed lane still holds cards. */
export interface BoardConfigOrphansError {
  error: string;
  orphans: { column: string; cards: number }[];
}

// ── Board lookup by repo ────────────────────────────────────────────────────

/** One row of `GET /v1/boards?repo=<git remote url>`. */
export interface BoardSummary {
  workspaceId: string;
  name: string;
  role: string;
  changeSeq: number;
  /** `host/owner/name`, or null. */
  repo: string | null;
}

/**
 * `GET /v1/boards?repo=` — the boards linked to a repo. `repo` is required; a
 * remote the server cannot read is a 400. Callers act only on exactly one.
 */
export interface BoardsForRepoResponse {
  /** The normalized form of the remote that was sent. */
  repo: string;
  boards: BoardSummary[];
}

// ── Cards ───────────────────────────────────────────────────────────────────

export interface ChecklistProgress {
  done: number;
  total: number;
}

export interface ChecklistItem {
  key: string;
  section: ChecklistSection;
  text: string;
  checked: boolean;
  checkedAt: IsoDate | null;
  note: string | null;
  group: string | null;
  /** The stream key this verify item proves, or null for the lead's. */
  stream: string | null;
}

/** A stream as stored and served (BE-19). */
export interface Stream {
  key: string;
  title: string;
  goal: string;
  role: StreamRole;
  owns: string[];
  reads: string[];
  dependsOn: string[];
  isolation: StreamIsolation;
  position: number;
}

/** How a lead runs a card with streams: who goes when, and what each is told. */
export interface Dispatch {
  waves: string[][];
  briefs: Record<string, string>;
}

export interface CardSource {
  kind: string;
  ref: string | null;
  checksum: string | null;
}

export interface CardAssignees {
  users: string[];
  agents: string[];
}

export interface CardLink {
  id: string;
  /** `blocked_by` appears only as the incoming side of a `blocks` row. */
  type: LinkType;
  direction: "outgoing" | "incoming";
  itemId: string;
}

export interface CardAttachment {
  id: string;
  name: string;
  reference: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceKind: string | null;
}

/** A card as a list page, the change feed and every write state it. */
export interface Card {
  id: string;
  workspaceId: string;
  seq: number;
  /** The `If-Match` precondition for edits; also the `ETag`. */
  revision: number;
  type: WorkItemType;
  parentId: string | null;
  columnKey: string;
  rank: string;
  title: string;
  body: string;
  priority: Priority | null;
  estimate: number | null;
  categoryKey: string | null;
  taskId: string | null;
  tags: string[];
  checklistProgress: ChecklistProgress;
  /** Always present; `[]` when the card has no plan. */
  streams: Stream[];
  metadata: Record<string, unknown> | null;
  source: CardSource | null;
  createdAt: IsoDate | null;
  updatedAt: IsoDate | null;
  startedAt: IsoDate | null;
  completedAt: IsoDate | null;
  dueAt: IsoDate | null;
  archivedAt: IsoDate | null;
}

/**
 * A card as a single-card read states it: the list shape plus its parts.
 *
 * ⚠️ Clients tell the two apart by whether `checklist` is present.
 */
export interface CardDetail extends Card {
  checklist: ChecklistItem[];
  /** Null when the card has no streams. */
  dispatch: Dispatch | null;
  assignees: CardAssignees;
  links: CardLink[];
  attachments: CardAttachment[];
  /** User ids following the card. */
  subscribers: string[];
  /** Whether the CALLER follows it. */
  subscribed: boolean;
  /** Whether the CALLER starred it. */
  favorite: boolean;
  commentCount: number;
}

/** `{ item }` with an `ETag: "<revision>"` header. */
export interface CardResponse {
  item: CardDetail;
}

/** 409 when `If-Match` named a revision that is no longer current. */
export interface CardConflictError {
  error: string;
  revision: number;
  item: CardDetail;
}

// ── Listing ─────────────────────────────────────────────────────────────────

/**
 * Query of `GET /v1/boards/:workspaceId/items` (and `/stats`, `/lookup`).
 * Every value is a string on the wire.
 */
export interface CardListQuery {
  column?: string;
  type?: WorkItemType;
  /** A card id, or `none` for top-level cards only. */
  parent?: string;
  /** A category key, or `none` for cards with no category. */
  category?: string;
  priority?: Priority | "none";
  tag?: string;
  /** 2-100 characters; every word must start a word of the title or task id. */
  q?: string;
  /** `user:<id>` or `agent:<slug>`. */
  assignee?: string;
  taskId?: string;
  /** `<kind>:<ref>`. */
  source?: string;
  /** `1` includes archived cards. */
  archived?: "1";
  /** 1-200; default 50. */
  limit?: string;
  /** Opaque, from the previous page. */
  cursor?: string;
}

/** `GET /v1/boards/:workspaceId/items` — ordered by (columnKey, rank, id). */
export interface CardListResponse {
  items: Card[];
  /** Null on the last page. */
  cursor: string | null;
  head: number;
}

/**
 * `GET /v1/boards/:workspaceId/lookup?taskId=` or `?source=` — EXACTLY one
 * selector. 404 when no card carries that identity.
 */
export type CardLookupResponse = CardResponse;

/** `GET /v1/boards/:workspaceId/stats` — takes `column`, `category`, `priority`, `tag`. */
export interface BoardStats {
  total: number;
  byColumn: Record<string, number>;
  /** Cards with no category are under `"none"`. */
  byCategory: Record<string, number>;
  /** Cards with no priority are under `"none"`. */
  byPriority: Record<string, number>;
}

export interface BoardStatsResponse {
  stats: BoardStats;
}

// ── Change feed ─────────────────────────────────────────────────────────────

/** A board-level change: it carries no card, so a client re-reads `/config`. */
export interface BoardEvent {
  seq: number;
  verb: string;
}

/** `GET /v1/boards/:workspaceId/changes?since=<seq>&limit=` — archived cards included. */
export interface BoardChangesResponse {
  head: number;
  /** The `since` to ask with next. */
  nextSince: number;
  hasMore: boolean;
  items: Card[];
  events: BoardEvent[];
}

// ── Presence ────────────────────────────────────────────────────────────────

export interface Presence {
  workItemId: string;
  userId: string;
  agent: string;
  machineId: string | null;
  lastSeenAt: IsoDate;
}

/** `GET /v1/boards/:workspaceId/presence`. */
export interface BoardPresenceResponse {
  presence: Presence[];
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Where a card lands in its lane. Neither: the bottom. */
export interface Placement {
  /** The card this one goes directly BELOW. */
  after?: string | null;
  /** The card this one goes directly ABOVE. */
  before?: string | null;
}

/** A checklist item as create, `PUT /checklist` and import send it. */
export interface ChecklistItemInput {
  /** Kept when sent (`D1`, `V1`); minted per section otherwise. */
  key?: string | null;
  section?: ChecklistSection;
  /** 1-2000 characters. */
  text: string;
  /** Absent keeps what the stored item says — NOT the same as `false`. */
  checked?: boolean;
  note?: string | null;
  group?: string | null;
  /** A stream key like `W0`; only on a verify item. */
  stream?: string | null;
}

/** A stream as create and update accept it. */
export interface StreamInput {
  /** `W0` … `W999`; minted when absent. */
  key?: string | null;
  title: string;
  goal: string;
  role: StreamRole;
  owns: string[];
  reads?: string[];
  depends_on?: string[];
  /** Default `worktree`. */
  isolation?: StreamIsolation;
}

export interface CardSourceInput {
  kind: string;
  ref: string;
  checksum?: string | null;
}

/**
 * `POST /v1/boards/:workspaceId/items` — 201 `{ item }`. Honors an
 * `Idempotency-Key` header: a replay answers 200 `{ item, idempotent: true }`.
 */
export interface CardCreateRequest {
  title: string;
  type?: WorkItemType;
  body?: string | null;
  /** Default: the board's intake lane. */
  columnKey?: string | null;
  parentId?: string | null;
  priority?: Priority | null;
  estimate?: number | null;
  categoryKey?: string | null;
  tags?: string[];
  dueAt?: IsoDate | null;
  checklist?: ChecklistItemInput[];
  streams?: StreamInput[] | null;
  assignees?: Partial<CardAssignees>;
  metadata?: Record<string, unknown> | null;
  placement?: Placement | null;
  source?: CardSourceInput;
}

export interface CardCreateResponse {
  item: CardDetail;
  /** Present when an `Idempotency-Key` replay returned the earlier card. */
  idempotent?: true;
}

/**
 * `PATCH /v1/boards/:workspaceId/items/:itemId` — `If-Match: <revision>` is
 * REQUIRED. Only the fields sent change; `null` clears one. `columnKey`,
 * `rank`, `revision`, `seq`, `taskId` and `taskSeq` are refused.
 */
export interface CardPatchRequest {
  type?: WorkItemType;
  title?: string;
  body?: string | null;
  priority?: Priority | null;
  estimate?: number | null;
  categoryKey?: string | null;
  tags?: string[];
  dueAt?: IsoDate | null;
  parentId?: string | null;
  metadata?: Record<string, unknown> | null;
  assignees?: Partial<CardAssignees>;
  /** The whole plan, replaced. `[]` or `null` clears it. */
  streams?: StreamInput[] | null;
}

/**
 * `POST /v1/boards/:workspaceId/items/:itemId/move` — `If-Match` optional.
 * Needs a `columnKey` or a placement.
 */
export interface CardMoveRequest {
  /** Null reorders inside the current lane. */
  columnKey?: string | null;
  placement?: Placement | null;
}

/** `PUT /v1/boards/:workspaceId/items/:itemId/checklist` — `If-Match` REQUIRED. */
export interface ChecklistReplaceRequest {
  items: ChecklistItemInput[];
}

/** 400 from `PUT /checklist` when the stream rules refuse it. */
export interface ChecklistReplaceError {
  error: string;
  errors: string[];
}

/** `PATCH /v1/boards/:workspaceId/items/:itemId/checklist/:key` — `If-Match` optional. */
export interface ChecklistItemPatchRequest {
  checked?: boolean;
  note?: string | null;
  text?: string;
  /** Retag a verify item to a stream; `null` gives it back to the lead. */
  stream?: string | null;
}

/** `DELETE /v1/boards/:workspaceId/items/:itemId` — archive (a tombstone). */
export interface CardArchiveResponse {
  archived: string;
  /** Absent when the card was already archived. */
  seq?: number;
}

/** `POST /v1/boards/:workspaceId/items/:itemId/restore`. */
export interface CardRestoreResponse {
  item: CardDetail | null;
  seq: number;
}

/** `POST /v1/boards/:workspaceId/items/:itemId/links` — 201. */
export interface CardLinkRequest {
  type: LinkType;
  targetId: string;
}

export interface CardLinkResponse {
  link: {
    id: string;
    fromId: string;
    toId: string;
    type: "blocks" | "relates" | "duplicates";
  };
}

/** `DELETE …/links/:linkId`. */
export interface CardUnlinkResponse {
  unlinked: string;
}

// ── Comments, flags, attachments ────────────────────────────────────────────

export interface Comment {
  id: string;
  authorKind: ActorKind;
  authorRef: string;
  /** Null once deleted: the comment keeps its place with its body gone. */
  body: string | null;
  createdAt: IsoDate;
  deletedAt: IsoDate | null;
}

/** `GET /v1/boards/:workspaceId/items/:itemId/comments` — oldest first. */
export interface CommentListResponse {
  comments: Comment[];
}

/** `POST …/comments` (201) and `PATCH …/comments/:commentId`. 1-20000 characters. */
export interface CommentRequest {
  body: string;
}

export interface CommentCreateResponse {
  comment: { id: string };
}

/** Only the author may edit; 409 on a deleted comment. */
export interface CommentPatchResponse {
  comment: { id: string; body: string; updatedAt: IsoDate };
}

/** `DELETE …/comments/:commentId` — a tombstone. Only the author may delete. */
export interface CommentDeleteResponse {
  deleted: string;
}

/** `PUT` / `DELETE …/subscription` — answers the state that now holds. */
export interface SubscriptionResponse {
  subscribed: boolean;
}

/** `PUT` / `DELETE …/favorite` — answers the state that now holds. */
export interface FavoriteResponse {
  favorite: boolean;
}

/** `POST …/attachments` — a reference to a file, not its bytes. 201. */
export interface AttachmentRequest {
  name: string;
  reference: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  sourceKind?: string | null;
}

export interface AttachmentResponse {
  attachment: CardAttachment;
}

/** `DELETE …/attachments/:attachmentId`. */
export interface AttachmentDeleteResponse {
  detached: string;
}

// ── History ─────────────────────────────────────────────────────────────────

export interface AuditEvent {
  seq: number;
  verb: string;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorMachineId: string | null;
  diff: unknown;
  at: IsoDate;
}

/** `GET …/items/:itemId/audit` — newest first. */
export interface AuditResponse {
  events: AuditEvent[];
}

export interface ActivityAudit extends AuditEvent {
  kind: "audit";
  id: string;
}

export interface ActivityComment {
  kind: "comment";
  id: string;
  authorKind: ActorKind;
  authorRef: string;
  /** The account behind the author; null on rows older than the column. */
  authorUserId: string | null;
  body: string | null;
  at: IsoDate;
  editedAt: IsoDate | null;
  deletedAt: IsoDate | null;
}

export type ActivityEntry = ActivityAudit | ActivityComment;

/** `GET …/items/:itemId/activity?limit=&cursor=` — oldest first, audit and comments merged. */
export interface ActivityResponse {
  events: ActivityEntry[];
  cursor: string | null;
}

// ── Migration and reset (owner only) ────────────────────────────────────────

export interface ImportChecklistItem extends ChecklistItemInput {
  /** Required when `checked` is true; refused when it is not. */
  checkedAt?: IsoDate | null;
}

export interface ImportRestore {
  /** The id the source already handed out, e.g. `BE-02`. */
  taskId?: string | null;
  /** Required alongside `taskId`. */
  taskSeq?: number | null;
  createdAt?: IsoDate | null;
  updatedAt?: IsoDate | null;
  rank?: string | null;
  checklist?: ImportChecklistItem[];
}

/**
 * One record of an import: a create body that MUST carry `source` and
 * `columnKey`, with its checklist under `restore`, never at the top level.
 */
export interface ImportRecord extends Omit<CardCreateRequest, "checklist"> {
  columnKey: string;
  source: CardSourceInput;
  restore?: ImportRestore | null;
  attachments?: AttachmentRequest[];
}

/** `POST /v1/boards/:workspaceId/import` — 1-50 records. */
export interface ImportRequest {
  records: ImportRecord[];
}

export type ImportReceiptStatus =
  | "imported"
  | "updated"
  | "skipped"
  | "conflict"
  | "failed";

export interface ImportReceipt {
  ref: string;
  status: ImportReceiptStatus;
  itemId?: string;
  taskId?: string | null;
  error?: string;
}

export interface ImportResponse {
  summary: Record<ImportReceiptStatus, number>;
  receipts: ImportReceipt[];
  head: number;
}

/** `POST /v1/boards/:workspaceId/migrated` — seal the cutover, verified by count. */
export interface MigratedRequest {
  items: number;
  manifest?: string | null;
}

export type MigratedResponse =
  | { migratedAt: IsoDate; items: number; seq: number }
  | { migratedAt: IsoDate; items: number; alreadySealed: true };

/** 409 from `/migrated` when the count does not match. */
export interface MigratedMismatchError {
  error: string;
  expected: number;
  actual: number;
}

/** `POST /v1/boards/:workspaceId/purge` — removes EVERY card. */
export interface PurgeRequest {
  /** Must be the project's slug, exactly. */
  confirm: string;
}

export interface PurgeResponse {
  deleted: number;
  seq: number;
}

// ── Icon ────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/boards/:workspaceId/icon` — image bytes, not JSON. 404 means no
 * icon; send `If-None-Match` with the last ETag for a 304.
 */
export const ICON_KEY_HEADER = "x-icon-key";
