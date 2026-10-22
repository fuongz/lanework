// `/v1/sync/*`: the machine surface for a user's projects. Machine credential
// only; `/v1/workspaces` is the session twin and refuses a machine with 401.
// Derived from the server's `routes/sync.ts`.

import type { IsoDate } from "./common";

export interface SyncProfile {
  name: string | null;
  birthYear: number | null;
  gender: string | null;
  language: string | null;
}

/** A project as `GET /v1/sync/state` states it. */
export interface SyncWorkspace {
  /** The board id. Every `/v1/boards/:workspaceId/…` takes it, not the slug. */
  id: string;
  slug: string;
  name: string;
  color: string | null;
  /** The R2 key of the project's icon, or null. */
  iconKey: string | null;
  laneworkStyle: boolean;
  baseBranch: string | null;
  addedAt: IsoDate;
  /** This machine's checkout, or null when it has none. */
  path: string | null;
  exposed: boolean;
}

export interface SyncRoleBinding {
  role: string;
  agent: string;
  provider: string;
  model: string;
}

/**
 * `GET /v1/sync/state`.
 *
 * Projects come ordered by position; archived ones are left out.
 */
export interface SyncStateResponse {
  profile: SyncProfile | null;
  workspaces: SyncWorkspace[];
  roles: SyncRoleBinding[];
  /** Null when the projects disagree (then `conflicts` names `autoRoute`). */
  autoRoute: boolean | null;
  /** `role:<name>` or `autoRoute` for values the projects disagree on. */
  conflicts: string[];
}

/** One project as `POST /v1/sync/state` pushes it. */
export interface SyncPushWorkspace {
  slug: string;
  name: string;
  color?: string | null;
  laneworkStyle?: boolean;
  baseBranch?: string | null;
  addedAt: IsoDate;
  /** This machine's checkout. Required. */
  path: string;
  exposed?: boolean;
}

/**
 * `POST /v1/sync/state`.
 *
 * Upserts up to 500 projects, the profile and the role bindings.
 */
export interface SyncStatePushRequest {
  profile?: Partial<SyncProfile>;
  workspaces?: SyncPushWorkspace[];
  roles?: { role: string; agent: string; provider?: string; model?: string }[];
  autoRoute?: boolean;
}

export interface SyncStatePushResponse {
  stored: number;
}

/**
 * `POST /v1/sync/state/workspace`: create a project.
 *
 * 409 with {@link SyncWorkspaceSlugTakenError} on a taken slug.
 */
export interface SyncWorkspaceCreateRequest {
  /** Lower-case, hyphenated, at most 64 characters. */
  slug: string;
  name: string;
  color?: string | null;
  baseBranch?: string | null;
  laneworkStyle?: boolean;
  autoRoute?: boolean;
  /** This machine's checkout, recorded when sent. */
  path?: string | null;
}

export interface SyncWorkspaceCreateResponse {
  workspace: {
    id: string;
    slug: string;
    name: string;
    color: string | null;
    baseBranch: string | null;
    path: string | null;
  };
}

/** 409 from `POST /v1/sync/state/workspace`: the project holding that slug. */
export interface SyncWorkspaceSlugTakenError {
  error: string;
  id: string;
}

/** `PATCH /v1/sync/state/workspace/:id`; the id is a UUID, not a slug. */
export interface SyncWorkspacePatchRequest {
  name?: string;
  color?: string | null;
  baseBranch?: string | null;
  laneworkStyle?: boolean;
  autoRoute?: boolean;
}

export interface SyncWorkspacePatchResponse {
  workspace: {
    id: string;
    slug: string;
    name: string;
    color: string | null;
    baseBranch: string | null;
  };
}

/** `PUT /v1/sync/state/workspace-order`: distinct ids, all the caller's. */
export interface SyncWorkspaceOrderRequest {
  ids: string[];
}

export interface SyncWorkspaceOrderResponse {
  ids: string[];
}

/** `DELETE /v1/sync/state/workspace/:id`. `deleted` is the slug, or null. */
export interface SyncWorkspaceDeleteResponse {
  deleted: string | null;
  id: string;
}
