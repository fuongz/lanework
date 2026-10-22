// Checkpoints: where an agent stopped on a card, so a different agent can
// pick it up. Written by the Stop hook and the MCP `checkpoint` tool; read by
// `get_review` and the desktop. Derived from the server's
// `board/checkpoint.ts` and the two routes in `routes/boards.ts`.
//
// Both routes take the card as its uuid or its task id (`BE-17`).

import type { IsoDate } from "./common";

/**
 * How many checkpoints a card keeps, newest first.
 *
 * Finishing or archiving the card clears them all.
 */
export const CHECKPOINTS_KEPT = 5;

/** The most a checkpoint's content may weigh, serialized as JSON. */
export const CHECKPOINT_MAX_BYTES = 16 * 1024;

export interface CheckpointCommand {
  command: string;
  /** Null when the outcome is unknown. */
  ok: boolean | null;
}

export interface CheckpointGit {
  branch: string | null;
  head: string | null;
  /** `refs/lanework/wip/<task-id>` when the uncommitted work was pushed. */
  wipRef: string | null;
  wipSha: string | null;
  diffStat: string | null;
}

/**
 * `POST /v1/boards/:workspaceId/items/:ref/checkpoints`, answered with 201.
 *
 * Lenient about length: over-long fields are cut, and lists keep their newest
 * entries (100 files, 30 commands). Strict about shape and the 16 KiB total.
 * 409 on a finished or archived card.
 */
export interface CheckpointRequest {
  /** Required, up to 6000 characters. */
  summary: string;
  /** What the agent was asked, in the user's words. Up to 2000 characters. */
  request?: string | null;
  /** The one thing the next agent should do first. Up to 1000 characters. */
  nextStep?: string | null;
  /** Repo-relative paths changed. */
  files?: string[];
  commands?: { command: string; ok?: boolean | null }[];
  host?: string | null;
  session?: string | null;
  git?: Partial<CheckpointGit> | null;
}

/** What the server stores, after trimming and bounding. */
export interface CheckpointContent {
  request: string | null;
  summary: string;
  nextStep: string | null;
  files: string[];
  commands: CheckpointCommand[];
  host: string | null;
  session: string | null;
  git: CheckpointGit | null;
}

/** A checkpoint as the wire carries it. */
export interface Checkpoint extends CheckpointContent {
  id: string;
  /** The writer's agent slug (`x-lanework-agent`), or `agent`. */
  agent: string;
  userId: string;
  machineId: string | null;
  createdAt: IsoDate;
}

export interface CheckpointCreateResponse {
  checkpoint: Checkpoint;
}

/**
 * The newest checkpoint, with `nextStep` carried forward from an older one.
 *
 * Carried only when the newest has none; `nextStepFrom` names that older row.
 */
export interface LatestCheckpoint extends Checkpoint {
  nextStepFrom: { id: string; agent: string; createdAt: IsoDate } | null;
}

/** `GET /v1/boards/:workspaceId/items/:ref/checkpoints`, newest first. */
export interface CheckpointListResponse {
  checkpoints: Checkpoint[];
  latest: LatestCheckpoint | null;
}
