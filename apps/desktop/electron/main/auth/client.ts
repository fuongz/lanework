import { hostname } from "node:os";
import {
  type CliAuthDeviceRequest,
  type CliAuthDeviceResponse,
  type CliAuthLoopbackRequest,
  type CliAuthLoopbackResponse,
  type CliTokenErrorCode,
  type CliTokenRequest,
  type CliTokenResponse,
  DEFAULT_API_ORIGIN,
  isMachineSecret,
  type MachineFacts,
  type MachineMeResponse,
  paths,
} from "@lanework/protocol";
import type { AccountOwner, Verdict } from "../../../shared/auth";
import { AUTH_BODY_CAP, readCappedJson } from "../http-body";
import { externalUrlOn, looksLikeUserCode } from "./redirect";
import type { MachineRecord } from "./store";

/**
 * The control plane this install talks to.
 *
 * `https`, never `http` (loopback aside): this origin receives a PKCE verifier
 * and hands back a machine credential, so the transport is part of the
 * security of the flow ({@link isAllowedApiUrl}).
 *
 * Overridable because local development needs to point at a stub or a
 * `wrangler dev`, and because self-hosting the control plane is a legitimate
 * thing to want. Precedence: an explicit origin (a record's own), then
 * `LANEWORK_API_URL`, then this ({@link resolveApi}).
 */
const DEFAULT_API = DEFAULT_API_ORIGIN;

/** Hosts an `http:` control plane may use: this machine, and nothing else. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Whether `value` may be a control-plane origin (FE-78/D6).
 *
 * `https:` anywhere, or `http:` on loopback only, for a local stub or a
 * `wrangler dev`. A URL carrying a user name or password is refused too: the
 * credential would ride along on every request.
 */
export function isAllowedApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** Origins already reported as refused, so a bad value logs once, not per call. */
const refusedApis = new Set<string>();

/**
 * The control-plane origin in force, with no trailing slash. Never empty.
 *
 * A candidate that is not {@link isAllowedApiUrl} (plain `http` to another
 * host, or not a URL) falls back to the default and is logged (FE-78/D6). The
 * origin receives a PKCE verifier and the machine credential, so a mistyped
 * or planted `LANEWORK_API_URL` must not send them in the clear.
 */
export function resolveApi(apiUrl?: string | null): string {
  const candidate = (apiUrl || process.env.LANEWORK_API_URL || DEFAULT_API)
    .trim()
    .replace(/\/+$/, "");
  if (isAllowedApiUrl(candidate)) return candidate;
  if (!refusedApis.has(candidate)) {
    refusedApis.add(candidate);
    console.warn(
      `Ignoring control-plane URL ${JSON.stringify(candidate)}: it must be https, or http on 127.0.0.1, ::1 or localhost, with no user name or password. Using ${DEFAULT_API}.`,
    );
  }
  return DEFAULT_API;
}

/**
 * What this machine tells the control plane about itself.
 *
 * Display data only.
 */
export function machineFacts(name?: string): MachineFacts & {
  hostname: string;
  os: string;
  arch: string;
} {
  const host = hostname();
  return {
    name: (name || host || "desktop").slice(0, 120),
    hostname: host,
    os: process.platform,
    arch: process.arch,
  };
}

/** Thrown when we could not reach the control plane at all. */
class UnreachableError extends Error {
  constructor(api: string, cause?: unknown) {
    super(
      `Could not reach the control plane at ${api} — check the network, or LANEWORK_API_URL. (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
    this.name = "UnreachableError";
  }
}

/**
 * The error for "the control plane answered, and said no".
 *
 * It always names the origin and the status. Passing the server's own `error`
 * string straight through produces messages like `not found` that could have
 * come from anywhere, which sends the reader looking in the wrong place.
 */
function refused(api: string, status: number, detail: string): Error {
  if (status === 404)
    return new Error(
      `${api} has no CLI login endpoint (HTTP 404) — it is older than this app, or LANEWORK_API_URL points somewhere else.`,
    );
  if (status === 429)
    return new Error(
      `${api} is rate limiting this machine (HTTP 429). Wait a minute and try again.`,
    );
  if (status >= 500)
    return new Error(
      `${api} could not handle the request (HTTP ${status}). That is a fault on the control plane; nothing was changed here.`,
    );
  return new Error(
    `${api} refused the request (HTTP ${status})${detail ? `: ${detail}` : ""}.`,
  );
}

/**
 * A response body as it arrives: the protocol's field names, every value
 * still unchecked.
 *
 * The server is on the other side of a network, so nothing it sends is
 * trusted until {@link str} or {@link externalUrlOn} has looked at it.
 */
type Unchecked<T> = { [K in keyof T]?: unknown } & Record<string, unknown>;

/**
 * POST `body` as JSON to `api` + `path`.
 *
 * @throws The caller's abort as is; any other network failure as an
 *   {@link UnreachableError}. An HTTP error status does not throw.
 */
async function postJson<Res>(
  api: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; data: Unchecked<Res> }> {
  let res: Response;
  try {
    res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // BOTH, not either: a caller's signal carries cancellation, and the
      // timeout keeps a hung connection from waiting out the sign-in's
      // ten-minute window instead of failing in fifteen seconds.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new UnreachableError(api, cause);
  }
  // Capped (FE-78/D8): an answer to sign-in is a few hundred bytes, and a
  // hostile origin must not be able to stream gigabytes into main.
  const data = await readCappedJson(res, AUTH_BODY_CAP).catch(() => ({}));
  return {
    status: res.status,
    ok: res.ok,
    data: data as Unchecked<Res>,
  };
}

/** `value` when it is a non-empty string of at most `max` chars, else null. */
function str(value: unknown, max = 2048): string | null {
  return typeof value === "string" && value && value.length <= max
    ? value
    : null;
}

/** A loopback login the control plane has registered. */
interface LoopbackStart {
  id: string;
  /** Checked to be on `api`'s own origin, so safe for `openExternal`. */
  authorizeUrl: string;
}

/**
 * Register a loopback login attempt and return where to send the browser.
 *
 * @throws When the control plane refuses, or answers with a login it does not
 *   describe.
 */
export async function startLoopback(
  api: string,
  input: {
    challenge: string;
    state: string;
    redirectUri: string;
    facts: ReturnType<typeof machineFacts>;
  },
  signal?: AbortSignal,
): Promise<LoopbackStart> {
  const { status, ok, data } = await postJson<CliAuthLoopbackResponse>(
    api,
    paths.cliAuth(),
    {
      mode: "loopback",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      redirect_uri: input.redirectUri,
      state: input.state,
      ...input.facts,
    } satisfies CliAuthLoopbackRequest,
    signal,
  );
  if (!ok) throw refused(api, status, str(data.error, 200) ?? "");

  const id = str(data.id, 64);
  const authorizeUrl = externalUrlOn(data.authorize_url, api);
  if (!id || !authorizeUrl)
    throw new Error(
      `${api} returned a login it did not describe (no id, or an authorize URL off its own origin).`,
    );
  return { id, authorizeUrl };
}

/** A device login the control plane has registered. */
interface DeviceStart {
  id: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
}

/**
 * Register a device login attempt and return the code a human retypes.
 *
 * @throws When the control plane refuses, or answers with a login it does not
 *   describe.
 */
export async function startDevice(
  api: string,
  input: { challenge: string; facts: ReturnType<typeof machineFacts> },
  signal?: AbortSignal,
): Promise<DeviceStart> {
  const { status, ok, data } = await postJson<CliAuthDeviceResponse>(
    api,
    paths.cliAuth(),
    {
      mode: "device",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      ...input.facts,
    } satisfies CliAuthDeviceRequest,
    signal,
  );
  if (!ok) throw refused(api, status, str(data.error, 200) ?? "");

  const id = str(data.id, 64);
  const deviceCode = str(data.device_code, 200);
  const verificationUri = externalUrlOn(data.verification_uri, api);
  if (
    !id ||
    !deviceCode ||
    !verificationUri ||
    !looksLikeUserCode(data.user_code)
  )
    throw new Error(
      `${api} returned a device login it did not describe (missing code, or a verification URL off its own origin).`,
    );
  // Resolved after the guard so it can fall back to the checked
  // `verificationUri`: a complete URL off the API's own origin must never
  // become the link we open.
  const complete =
    externalUrlOn(data.verification_uri_complete, api) ?? verificationUri;
  const interval = Number(data.interval);
  return {
    id,
    deviceCode,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete: complete,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

/**
 * What a token exchange answered.
 *
 * The device flow's "not yet" answers are told apart so polling can react.
 */
type PollOutcome =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied" }
  | { state: "expired" }
  | ({ state: "issued" } & CliTokenResponse);

/**
 * Exchange an approved request for a machine credential.
 *
 * Unauthenticated by design: possession of the code plus the PKCE verifier IS
 * the authentication, and that pair only ever exists in this process.
 *
 * @throws When the control plane rejects the exchange for any reason other
 *   than the device flow's "not yet" answers.
 */
export async function redeem(
  api: string,
  grant: { code?: string; deviceCode?: string },
  verifier: string,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  const { status, ok, data } = await postJson<
    CliTokenResponse & { error: CliTokenErrorCode }
  >(
    api,
    paths.cliToken(),
    {
      ...(grant.code ? { code: grant.code } : {}),
      ...(grant.deviceCode ? { device_code: grant.deviceCode } : {}),
      code_verifier: verifier,
    } satisfies CliTokenRequest,
    signal,
  );

  const machineId = str(data.machineId, 64);
  // Only a well-formed machine secret is accepted (FE-78/D1): it is stored,
  // sent as a bearer token and written into a `security -i` line for the
  // hook, so a value the protocol does not describe never gets that far.
  const secret = isMachineSecret(data.secret) ? data.secret : null;
  if (ok && machineId && secret) return { state: "issued", machineId, secret };
  if (ok && machineId && data.secret !== undefined && !secret)
    throw new Error(
      `${api} issued a credential this app does not recognise. Nothing was stored; try signing in again.`,
    );

  switch (data.error as CliTokenErrorCode | undefined) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow_down" };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
      return { state: "expired" };
  }

  // 401 is the control plane's ONE generic answer for a wrong, unapproved,
  // spent or expired code or a bad verifier. It is spelled out here, where the
  // person who just clicked sign-in knows which of them applies to them.
  if (status === 401)
    throw new Error(
      `${api} rejected this sign-in — it expired, was already used, or was never approved. Try signing in again.`,
    );
  throw refused(api, status, str(data.error, 200) ?? "");
}

// ── What the control plane currently thinks of us ────────────────────────────

/** The last answer {@link probe} got, or null before the first. */
let verdict: Verdict | null = null;
/** When {@link verdict} was learned (epoch ms); 0 before the first. */
let verdictAt = 0;

/**
 * How long a verdict is trusted before we ask again.
 *
 * Well under a heartbeat interval: whoever reads this has usually just revoked
 * something in a browser and switched back, so the cache absorbs a burst of
 * reads rather than sparing the minute after a revoke.
 */
const VERDICT_FRESH_MS = 15_000;

/** The last verdict and when it was learned, without asking again. */
export function cachedVerdict(): {
  verdict: Verdict | null;
  checkedAt: number;
} {
  return { verdict, checkedAt: verdictAt };
}

/**
 * Forget the verdict.
 *
 * Changing WHICH machine we are has to: the old verdict was about another
 * credential.
 */
export function resetVerdict(): void {
  verdict = null;
  verdictAt = 0;
}

/** The owner block from `/v1/machines/me`, or null when it did not say. */
function ownerOf(value: unknown): AccountOwner | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const owner = {
    name: str(raw.name, 200),
    email: str(raw.email, 320),
    image: str(raw.image, 2048),
  };
  // All three absent is the same as no owner at all: better to fall back to
  // whatever was stored than to overwrite it with a row of nulls.
  return owner.name || owner.email || owner.image ? owner : null;
}

/**
 * Ask whether our credential still works, and learn our own `userId`.
 *
 * `/v1/machines/me` rather than a dedicated verify route: it is the one route
 * a machine may call holding nothing but its own credential, and the control
 * plane answers 401 for revoked and unknown alike. That is the question "does
 * the other side still accept this?".
 *
 * NOTE: Revocation happens on the SERVER and nothing travels back down to
 * this machine, so a status read that only looks at the file answers "signed
 * in" forever. This is the only thing that can say otherwise.
 */
export async function probe(record: MachineRecord): Promise<{
  verdict: Verdict;
  userId: string | null;
  owner: AccountOwner | null;
}> {
  const api = resolveApi(record.apiUrl);
  try {
    const res = await fetch(`${api}${paths.machinesMe()}`, {
      headers: { authorization: `Bearer ${record.secret}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401) verdict = "revoked";
    else if (res.ok) verdict = "ok";
    else verdict = "unreachable";

    let userId = record.userId;
    let owner = record.owner;
    if (res.ok) {
      const data = (await readCappedJson(res, AUTH_BODY_CAP).catch(
        () => ({}),
      )) as Unchecked<MachineMeResponse>;
      userId = str(data.userId, 64) ?? userId;
      // Kept when the response omits it, rather than cleared. A control plane
      // older than this field is a working control plane, and blanking a name
      // we already had would make the account screen worse on upgrade.
      owner = ownerOf(data.user) ?? owner;
    }
    verdictAt = Date.now();
    return { verdict, userId, owner };
  } catch {
    verdict = "unreachable";
    verdictAt = Date.now();
    return { verdict, userId: record.userId, owner: record.owner };
  }
}

/** {@link probe}, but only when the cached answer has gone stale. */
export async function probeIfStale(record: MachineRecord): Promise<{
  verdict: Verdict | null;
  userId: string | null;
  owner: AccountOwner | null;
}> {
  if (verdict && Date.now() - verdictAt <= VERDICT_FRESH_MS)
    return { verdict, userId: record.userId, owner: record.owner };
  return probe(record);
}

/**
 * Revoke this machine on the control plane; sign-out calls this first.
 *
 * A narrow exception to "a machine may not do a human's job": it can only
 * ever REMOVE the caller's own access, so a thief who uses it has disarmed
 * themselves. Best effort: a failure here must not strand a user who asked to
 * sign out, so the local credential is dropped either way.
 *
 * @returns Whether the control plane confirmed the revoke.
 */
export async function revokeSelf(record: MachineRecord): Promise<boolean> {
  const api = resolveApi(record.apiUrl);
  try {
    const res = await fetch(`${api}${paths.machinesMe()}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${record.secret}` },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
