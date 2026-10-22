// Enrolling a machine and asking what the control plane thinks of it:
// `/v1/cli/*` (`lanework login`, loopback PKCE and device code) and
// `/v1/machines/*`. Derived from the server's `routes/cli.ts` and
// `routes/machines.ts`.

import type { IsoDate } from "./common";

// ── Machine facts ───────────────────────────────────────────────────────────

/** A coding-agent CLI found on the machine. Unknown providers are ignored. */
export interface MachineProvider {
  provider: "claude" | "codex";
  version?: string;
}

/**
 * What a client tells the control plane about the machine it enrols.
 *
 * Display data only; the server bounds and trims every field.
 */
export interface MachineFacts {
  /** 1-120 characters. Required. */
  name: string;
  /** At most 200 characters. */
  hostname?: string | null;
  /** At most 40 characters, e.g. `darwin`. */
  os?: string | null;
  /** At most 40 characters, e.g. `arm64`. */
  arch?: string | null;
  providers?: MachineProvider[];
}

/**
 * A machine credential, returned once.
 *
 * Returned by `POST /v1/cli/token` and `POST /v1/machines/register`, both
 * with HTTP 201. Only its hash is stored.
 */
export interface MachineCredential {
  machineId: string;
  /** `lw_mch_…`. Sent back as `Authorization: Bearer <secret>`. */
  secret: string;
}

// ── POST /v1/cli/auth — start a login ───────────────────────────────────────

/**
 * The PKCE challenge method: S256 only.
 *
 * `plain` would let anyone who reads the authorize URL forge the proof.
 */
export type PkceMethod = "S256";

interface CliAuthBase extends MachineFacts {
  /** base64url(SHA-256(verifier)), 43 characters. */
  code_challenge: string;
  code_challenge_method: PkceMethod;
}

/** Loopback: the browser comes back to a listener on this machine. */
export interface CliAuthLoopbackRequest extends CliAuthBase {
  /** Absent or anything but `"device"` means loopback. */
  mode?: "loopback";
  /** `http://127.0.0.1:<port>/oauth/callback`, no query, no fragment. */
  redirect_uri: string;
  /** 8-128 url-safe characters, echoed back on the callback. */
  state: string;
}

/** Device: a human types a short code on another machine. */
export interface CliAuthDeviceRequest extends CliAuthBase {
  mode: "device";
}

export type CliAuthRequest = CliAuthLoopbackRequest | CliAuthDeviceRequest;

export interface CliAuthLoopbackResponse {
  id: string;
  /** On the API's own origin: `<api>/cli/authorize?id=<id>`. */
  authorize_url: string;
  /** Seconds the attempt stays alive (600). */
  expires_in: number;
}

export interface CliAuthDeviceResponse {
  id: string;
  /** `lw_dev_…`. The redeem secret; never shown to a human. */
  device_code: string;
  /** `XXXX-XXXX` from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. */
  user_code: string;
  /** `<api>/cli/device`. */
  verification_uri: string;
  /** `<api>/cli/device?code=<user_code>`. */
  verification_uri_complete: string;
  /** Seconds to wait between polls of `/v1/cli/token` (5). */
  interval: number;
  /** Seconds the attempt stays alive (600). */
  expires_in: number;
}

export type CliAuthResponse = CliAuthLoopbackResponse | CliAuthDeviceResponse;

/**
 * Where the loopback flow lands: the API sends the browser to
 * `<redirect_uri>?code=<lw_code_…>&state=<state>`.
 */
export const LOOPBACK_CALLBACK_PATH = "/oauth/callback";

export interface LoopbackCallbackQuery {
  /** `lw_code_…`, useless without the PKCE verifier. */
  code: string;
  state: string;
}

// ── GET /v1/cli/request, POST /v1/cli/approve — the consent screen ─────────
// Session-authenticated (a signed-in human in a browser), not machine routes.

/** `GET /v1/cli/request?id=…` or `?user_code=…`. */
export interface CliRequestView {
  id: string;
  mode: "loopback" | "device";
  machineName: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  createdAt: IsoDate;
  expiresAt: IsoDate;
}

/** `POST /v1/cli/approve`. One of `id` or `user_code` is required. */
export interface CliApproveRequest {
  id?: string;
  user_code?: string;
  /** Anything but `"deny"` allows. */
  decision?: "allow" | "deny";
}

export type CliApproveResponse =
  | { decision: "deny" }
  /** Loopback approvals carry the URL the browser must follow next. */
  | { decision: "allow"; redirect_to?: string };

// ── POST /v1/cli/token — redeem ─────────────────────────────────────────────

/**
 * The body of `POST /v1/cli/token`, which is unauthenticated.
 *
 * The code (or device code) plus the PKCE verifier is the authentication.
 * Send `code` for loopback, `device_code` for device.
 */
export interface CliTokenRequest {
  code?: string;
  device_code?: string;
  code_verifier: string;
}

/** The 201 answer of `POST /v1/cli/token`: the credential. */
export type CliTokenResponse = MachineCredential;

/**
 * The device flow's "not yet" answers (HTTP 400), in RFC 8628's vocabulary.
 *
 * `invalid_grant` at HTTP 401 is the one answer for a wrong, unapproved,
 * spent or expired code, or a bad verifier.
 */
export type CliTokenErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_request";

export interface CliTokenError {
  error: CliTokenErrorCode;
  /** Present on the device-flow poll answers. */
  interval?: number;
}

// ── /v1/machines ────────────────────────────────────────────────────────────

/**
 * `POST /v1/machines/register`: trade a registration token for a credential.
 */
export interface MachineRegisterRequest extends MachineFacts {
  /** `lw_reg_…`, single use, 15 minutes. */
  token: string;
}

/**
 * The 201 answer of `POST /v1/machines/register`.
 *
 * A 401 is one message for "wrong", "already used" and "expired".
 */
export type MachineRegisterResponse = MachineCredential;

/** The account behind a machine. Each field may be null. */
export interface MachineOwner {
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * `GET /v1/machines/me` (machine credential): who this machine is, and whose.
 *
 * Doubles as the presence ping. 401 means revoked or unknown, alike.
 */
export interface MachineMeResponse {
  machineId: string;
  name: string;
  userId: string;
  /** Null when the account row is gone; absent on an older control plane. */
  user: MachineOwner | null;
}

/** `DELETE /v1/machines/me` (machine), `DELETE /v1/machines/:id` (session). */
export interface MachineRevokeResponse {
  revoked: string;
}

/** `POST /v1/machines/heartbeat` (machine). */
export interface MachineHeartbeatResponse {
  ok: true;
}

/** One row of `GET /v1/machines` (session). */
export interface MachineSummary {
  id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  createdAt: IsoDate;
  lastSeenAt: IsoDate | null;
  revokedAt: IsoDate | null;
  /** Derived from `lastSeenAt`: seen within about 7 minutes and not revoked. */
  online: boolean;
}

export interface MachineListResponse {
  machines: MachineSummary[];
}

/** `POST /v1/tokens/registration` (session): what `/setup` mints. */
export interface RegistrationTokenResponse {
  /** `lw_reg_…`. */
  token: string;
  expiresAt: IsoDate;
  command: string;
}
