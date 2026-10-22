// Every endpoint the desktop app and the checkpoint hook call, as a path
// builder plus one map from `"METHOD /path"` to its request and response. The
// map is types only: it lets a client name an endpoint and get both halves of
// the contract from one key.

import type {
  CliAuthRequest,
  CliAuthResponse,
  CliTokenRequest,
  CliTokenResponse,
  MachineHeartbeatResponse,
  MachineMeResponse,
  MachineRegisterRequest,
  MachineRegisterResponse,
  MachineRevokeResponse,
} from "./auth";
import type {
  ActivityResponse,
  AttachmentDeleteResponse,
  AttachmentRequest,
  AttachmentResponse,
  AuditResponse,
  BoardChangesResponse,
  BoardConfigPutResponse,
  BoardConfigRequest,
  BoardConfigResponse,
  BoardPresenceResponse,
  BoardRepoRequest,
  BoardRepoResponse,
  BoardStatsResponse,
  BoardsForRepoResponse,
  CardArchiveResponse,
  CardCreateRequest,
  CardCreateResponse,
  CardLinkRequest,
  CardLinkResponse,
  CardListResponse,
  CardLookupResponse,
  CardMoveRequest,
  CardPatchRequest,
  CardResponse,
  CardRestoreResponse,
  CardUnlinkResponse,
  ChecklistItemPatchRequest,
  ChecklistReplaceRequest,
  CommentCreateResponse,
  CommentDeleteResponse,
  CommentListResponse,
  CommentPatchResponse,
  CommentRequest,
  FavoriteResponse,
  ImportRequest,
  ImportResponse,
  MigratedRequest,
  MigratedResponse,
  PurgeRequest,
  PurgeResponse,
  SubscriptionResponse,
} from "./boards";
import type {
  CheckpointCreateResponse,
  CheckpointListResponse,
  CheckpointRequest,
} from "./checkpoints";
import type { HealthResponse } from "./common";
import type {
  SyncStatePushRequest,
  SyncStatePushResponse,
  SyncStateResponse,
  SyncWorkspaceCreateRequest,
  SyncWorkspaceCreateResponse,
  SyncWorkspaceDeleteResponse,
  SyncWorkspaceOrderRequest,
  SyncWorkspaceOrderResponse,
  SyncWorkspacePatchRequest,
  SyncWorkspacePatchResponse,
} from "./sync";

const seg = encodeURIComponent;

/**
 * Paths, relative to the API origin.
 *
 * Every dynamic segment is URI-encoded here, so a caller never builds one by
 * hand.
 */
export const paths = {
  health: () => "/v1/health",

  cliAuth: () => "/v1/cli/auth",
  cliToken: () => "/v1/cli/token",

  machinesRegister: () => "/v1/machines/register",
  machinesMe: () => "/v1/machines/me",
  machinesHeartbeat: () => "/v1/machines/heartbeat",

  syncState: () => "/v1/sync/state",
  syncWorkspace: () => "/v1/sync/state/workspace",
  syncWorkspaceById: (id: string) => `/v1/sync/state/workspace/${seg(id)}`,
  syncWorkspaceOrder: () => "/v1/sync/state/workspace-order",

  boardsForRepo: (remote: string) => `/v1/boards?repo=${seg(remote)}`,
  boardRepo: (workspaceId: string) => `/v1/boards/${seg(workspaceId)}/repo`,
  boardConfig: (workspaceId: string) => `/v1/boards/${seg(workspaceId)}/config`,
  boardIcon: (workspaceId: string) => `/v1/boards/${seg(workspaceId)}/icon`,
  boardPresence: (workspaceId: string) =>
    `/v1/boards/${seg(workspaceId)}/presence`,
  boardStats: (workspaceId: string, query?: Query) =>
    withQuery(`/v1/boards/${seg(workspaceId)}/stats`, query),
  boardChanges: (workspaceId: string, since: number, limit?: number) =>
    `/v1/boards/${seg(workspaceId)}/changes?since=${since}${
      limit === undefined ? "" : `&limit=${limit}`
    }`,
  boardLookup: (
    workspaceId: string,
    by: { taskId: string } | { source: string },
  ) =>
    `/v1/boards/${seg(workspaceId)}/lookup?${
      "taskId" in by ? `taskId=${seg(by.taskId)}` : `source=${seg(by.source)}`
    }`,
  boardImport: (workspaceId: string) => `/v1/boards/${seg(workspaceId)}/import`,
  boardMigrated: (workspaceId: string) =>
    `/v1/boards/${seg(workspaceId)}/migrated`,
  boardPurge: (workspaceId: string) => `/v1/boards/${seg(workspaceId)}/purge`,

  items: (workspaceId: string, query?: Query) =>
    withQuery(`/v1/boards/${seg(workspaceId)}/items`, query),
  item: (workspaceId: string, itemId: string) =>
    `/v1/boards/${seg(workspaceId)}/items/${seg(itemId)}`,
  itemMove: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/move`,
  itemRestore: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/restore`,
  itemChecklist: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/checklist`,
  itemChecklistItem: (workspaceId: string, itemId: string, key: string) =>
    `${paths.item(workspaceId, itemId)}/checklist/${seg(key)}`,
  itemLinks: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/links`,
  itemLink: (workspaceId: string, itemId: string, linkId: string) =>
    `${paths.item(workspaceId, itemId)}/links/${seg(linkId)}`,
  itemComments: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/comments`,
  itemComment: (workspaceId: string, itemId: string, commentId: string) =>
    `${paths.item(workspaceId, itemId)}/comments/${seg(commentId)}`,
  itemSubscription: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/subscription`,
  itemFavorite: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/favorite`,
  itemAttachments: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/attachments`,
  itemAttachment: (workspaceId: string, itemId: string, attachmentId: string) =>
    `${paths.item(workspaceId, itemId)}/attachments/${seg(attachmentId)}`,
  itemAudit: (workspaceId: string, itemId: string) =>
    `${paths.item(workspaceId, itemId)}/audit`,
  itemActivity: (workspaceId: string, itemId: string, query?: Query) =>
    withQuery(`${paths.item(workspaceId, itemId)}/activity`, query),
  /** `ref` is the card's uuid or its task id (`BE-17`). */
  itemCheckpoints: (workspaceId: string, ref: string) =>
    `/v1/boards/${seg(workspaceId)}/items/${seg(ref)}/checkpoints`,
} as const;

/** A query string, or anything that stringifies to one (`URLSearchParams`). */
export type Query = string | { toString(): string };

function withQuery(path: string, query?: Query): string {
  const text = query === undefined ? "" : String(query);
  return text ? `${path}?${text}` : path;
}

/** The authentication an endpoint takes. */
export type EndpointAuth =
  /** None: the body is the proof (PKCE, a registration token), or public. */
  | "none"
  /** `Authorization: Bearer <machine secret>` only. */
  | "machine"
  /** A machine credential or a browser session (`actorAuth`). */
  | "actor";

interface Endpoint<Req, Res, A extends EndpointAuth> {
  request: Req;
  response: Res;
  auth: A;
}

/**
 * Every endpoint, by `"METHOD /path"`.
 *
 * A `void` request has no body. Query parameters are in the path builders.
 */
export interface Endpoints {
  "GET /v1/health": Endpoint<void, HealthResponse, "none">;

  "POST /v1/cli/auth": Endpoint<CliAuthRequest, CliAuthResponse, "none">;
  "POST /v1/cli/token": Endpoint<CliTokenRequest, CliTokenResponse, "none">;

  "POST /v1/machines/register": Endpoint<
    MachineRegisterRequest,
    MachineRegisterResponse,
    "none"
  >;
  "GET /v1/machines/me": Endpoint<void, MachineMeResponse, "machine">;
  "DELETE /v1/machines/me": Endpoint<void, MachineRevokeResponse, "machine">;
  "POST /v1/machines/heartbeat": Endpoint<
    void,
    MachineHeartbeatResponse,
    "machine"
  >;

  "GET /v1/sync/state": Endpoint<void, SyncStateResponse, "machine">;
  "POST /v1/sync/state": Endpoint<
    SyncStatePushRequest,
    SyncStatePushResponse,
    "machine"
  >;
  "POST /v1/sync/state/workspace": Endpoint<
    SyncWorkspaceCreateRequest,
    SyncWorkspaceCreateResponse,
    "machine"
  >;
  "PATCH /v1/sync/state/workspace/:id": Endpoint<
    SyncWorkspacePatchRequest,
    SyncWorkspacePatchResponse,
    "machine"
  >;
  "DELETE /v1/sync/state/workspace/:id": Endpoint<
    void,
    SyncWorkspaceDeleteResponse,
    "machine"
  >;
  "PUT /v1/sync/state/workspace-order": Endpoint<
    SyncWorkspaceOrderRequest,
    SyncWorkspaceOrderResponse,
    "machine"
  >;

  "GET /v1/boards": Endpoint<void, BoardsForRepoResponse, "actor">;
  "PUT /v1/boards/:workspaceId/repo": Endpoint<
    BoardRepoRequest,
    BoardRepoResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/config": Endpoint<
    void,
    BoardConfigResponse,
    "actor"
  >;
  "PUT /v1/boards/:workspaceId/config": Endpoint<
    BoardConfigRequest,
    BoardConfigPutResponse,
    "actor"
  >;
  /** Image bytes, not JSON. */
  "GET /v1/boards/:workspaceId/icon": Endpoint<void, ArrayBuffer, "actor">;
  "GET /v1/boards/:workspaceId/presence": Endpoint<
    void,
    BoardPresenceResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/stats": Endpoint<
    void,
    BoardStatsResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/changes": Endpoint<
    void,
    BoardChangesResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/lookup": Endpoint<
    void,
    CardLookupResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items": Endpoint<
    void,
    CardListResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items": Endpoint<
    CardCreateRequest,
    CardCreateResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items/:itemId": Endpoint<
    void,
    CardResponse,
    "actor"
  >;
  "PATCH /v1/boards/:workspaceId/items/:itemId": Endpoint<
    CardPatchRequest,
    CardResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId": Endpoint<
    void,
    CardArchiveResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:itemId/restore": Endpoint<
    void,
    CardRestoreResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:itemId/move": Endpoint<
    CardMoveRequest,
    CardResponse,
    "actor"
  >;
  "PUT /v1/boards/:workspaceId/items/:itemId/checklist": Endpoint<
    ChecklistReplaceRequest,
    CardResponse,
    "actor"
  >;
  "PATCH /v1/boards/:workspaceId/items/:itemId/checklist/:key": Endpoint<
    ChecklistItemPatchRequest,
    CardResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:itemId/links": Endpoint<
    CardLinkRequest,
    CardLinkResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId/links/:linkId": Endpoint<
    void,
    CardUnlinkResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items/:itemId/comments": Endpoint<
    void,
    CommentListResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:itemId/comments": Endpoint<
    CommentRequest,
    CommentCreateResponse,
    "actor"
  >;
  "PATCH /v1/boards/:workspaceId/items/:itemId/comments/:commentId": Endpoint<
    CommentRequest,
    CommentPatchResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId/comments/:commentId": Endpoint<
    void,
    CommentDeleteResponse,
    "actor"
  >;
  "PUT /v1/boards/:workspaceId/items/:itemId/subscription": Endpoint<
    void,
    SubscriptionResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId/subscription": Endpoint<
    void,
    SubscriptionResponse,
    "actor"
  >;
  "PUT /v1/boards/:workspaceId/items/:itemId/favorite": Endpoint<
    void,
    FavoriteResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId/favorite": Endpoint<
    void,
    FavoriteResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:itemId/attachments": Endpoint<
    AttachmentRequest,
    AttachmentResponse,
    "actor"
  >;
  "DELETE /v1/boards/:workspaceId/items/:itemId/attachments/:attachmentId": Endpoint<
    void,
    AttachmentDeleteResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items/:itemId/audit": Endpoint<
    void,
    AuditResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items/:itemId/activity": Endpoint<
    void,
    ActivityResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/items/:ref/checkpoints": Endpoint<
    CheckpointRequest,
    CheckpointCreateResponse,
    "actor"
  >;
  "GET /v1/boards/:workspaceId/items/:ref/checkpoints": Endpoint<
    void,
    CheckpointListResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/import": Endpoint<
    ImportRequest,
    ImportResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/migrated": Endpoint<
    MigratedRequest,
    MigratedResponse,
    "actor"
  >;
  "POST /v1/boards/:workspaceId/purge": Endpoint<
    PurgeRequest,
    PurgeResponse,
    "actor"
  >;
}

export type EndpointKey = keyof Endpoints;
export type RequestOf<K extends EndpointKey> = Endpoints[K]["request"];
export type ResponseOf<K extends EndpointKey> = Endpoints[K]["response"];
