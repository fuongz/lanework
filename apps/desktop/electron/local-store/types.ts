import type {
  BoardCategory,
  BoardColumn,
  BoardLabel,
  ChecklistItemInput,
  IsoDate,
  Placement,
  Priority,
  StreamInput,
  TagPolicy,
  WorkItemType,
} from "@lanework/protocol";

/**
 * What a local board is configured with.
 *
 * The cloud's `BoardConfig` minus the cloud-only parts.
 */
export interface LocalBoardConfig {
  columns: BoardColumn[];
  categories: BoardCategory[];
  labels: BoardLabel[];
  tags: TagPolicy;
}

/** A row of `workspace`, decoded. */
export interface LocalWorkspace {
  id: string;
  slug: string;
  name: string;
  /** Normalized `host/owner/name`, or null. */
  repo: string | null;
  config: LocalBoardConfig;
  /** Last sequence handed out per category key: `{ frontend: 12 }`. */
  taskHeads: Record<string, number>;
  cloudId: string | null;
  syncedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  deletedAt: IsoDate | null;
}

export interface WorkspaceCreateInput {
  name: string;
  /** Derived from `name` when absent; made unique with `-2`, `-3`, … */
  slug?: string;
  /** Any git remote spelling; stored normalized. */
  repo?: string | null;
  config?: Partial<LocalBoardConfig>;
}

export interface WorkspaceUpdateInput {
  name?: string;
  slug?: string;
  config?: Partial<LocalBoardConfig>;
  cloudId?: string | null;
  syncedAt?: IsoDate | null;
}

/**
 * What a card keeps from the source it is restored from.
 *
 * Used by `review-import` to keep an id a source already handed out
 * (`restore.taskId/taskSeq`). Both or neither, as the cloud demands.
 */
export interface WorkItemRestore {
  taskId?: string | null;
  taskSeq?: number | null;
  createdAt?: IsoDate | null;
  updatedAt?: IsoDate | null;
  /** Checked items here keep their `checkedAt`. Replaces `checklist`. */
  checklist?: (ChecklistItemInput & { checkedAt?: IsoDate | null })[];
}

export interface WorkItemCreateInput {
  title: string;
  type?: WorkItemType;
  body?: string | null;
  /** Default: the intake lane (`backlog` on the default board). */
  columnKey?: string | null;
  parentId?: string | null;
  priority?: Priority | null;
  categoryKey?: string | null;
  tags?: string[];
  checklist?: ChecklistItemInput[];
  streams?: StreamInput[] | null;
  placement?: Placement | null;
  restore?: WorkItemRestore | null;
}

/**
 * A card edit: the cloud's `CardPatchRequest`, plus a checklist replace.
 *
 * The revision precondition is in {@link WriteOptions}.
 */
export interface WorkItemUpdateInput {
  type?: WorkItemType;
  title?: string;
  body?: string | null;
  priority?: Priority | null;
  /** Changing the category does not re-mint the task id, as on the cloud. */
  categoryKey?: string | null;
  tags?: string[];
  parentId?: string | null;
  streams?: StreamInput[] | null;
  /** The whole checklist, replaced (`PUT /checklist`). */
  checklist?: ChecklistItemInput[];
  cloudId?: string | null;
}

export interface WorkItemListQuery {
  column?: string;
  category?: string | "none";
  /** A card id, or `none` for top-level cards only. */
  parent?: string | "none";
  priority?: Priority | "none";
  tag?: string;
  /** Include tombstoned cards. */
  includeDeleted?: boolean;
}

export interface WriteOptions {
  /** Refuse with `conflict` unless the card is still at this revision. */
  ifRevision?: number;
}

export interface CheckpointWriter {
  /** `x-lanework-agent`; default `agent`. */
  agent?: string;
  /** Default `local`. */
  userId?: string;
  machineId?: string | null;
}

type LocalStoreErrorCode = "not_found" | "invalid" | "conflict" | "closed";

export class LocalStoreError extends Error {
  readonly code: LocalStoreErrorCode;
  constructor(code: LocalStoreErrorCode, message: string) {
    super(message);
    this.name = "LocalStoreError";
    this.code = code;
  }
}
