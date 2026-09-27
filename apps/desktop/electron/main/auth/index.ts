import { shell } from "electron";
import {
  anonymousSession,
  authChannels,
  type Principal,
  type RedactedSession,
  type SignInMode,
  type SignInProgress,
  type Verdict,
} from "../../../shared/auth";
import { can } from "../../../shared/policy";
import { forgetHookCredential, syncHandoff } from "../handoff";
import { broadcast, handle } from "../ipc";
import * as api from "./client";
import { listenForCallback } from "./loopback";
import { newState, pkcePair } from "./pkce";
import { CALLBACK_PATH, parseLoopbackRedirect } from "./redirect";
import {
  clearRecord,
  type MachineRecord,
  readRecord,
  writeRecord,
} from "./store";

/** How long a device sign-in may stay open. Matches the server's TTL. */
const DEVICE_WAIT_MS = 10 * 60 * 1000;

/**
 * How often main re-asks the control plane whether our credential still works.
 *
 * ⚠️ This timer is what makes revocation LAND. Revoking happens on the server
 * and nothing travels down to this machine, and `currentSession()` only probes
 * when something asks it — so with no beat, a revoked install keeps showing the
 * app until the user happens to trigger a read. The reference daemon beats at
 * the same 60s, and `/v1/machines/me` doubles as its presence ping.
 *
 * `LANEWORK_HEARTBEAT_MS` tunes it. The honest motivation is testability — a
 * test has to watch a revocation land without sitting through a minute — but it
 * is a legitimate operational knob either way, and it sits beside the other
 * `LANEWORK_*` values. Floored at one second so a stray value cannot turn this
 * into a request loop against the control plane.
 */
const DEFAULT_HEARTBEAT_MS = 60_000;

function heartbeatMs(): number {
  const raw = Number(process.env.LANEWORK_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.max(1_000, raw)
    : DEFAULT_HEARTBEAT_MS;
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

/** The last session pushed to renderers, so a beat that changes nothing is silent. */
let lastPublished: string | null = null;

/** The sign-in currently running, so a second one can be refused and this one cancelled. */
let inFlight: AbortController | null = null;

/**
 * The principal a record implies.
 *
 * `unreachable` deliberately stays a `machine`: being offline is not being
 * signed out, and the last known identity is what local-only work runs as.
 */
function principalOf(
  record: MachineRecord | null,
  verdict: Verdict | null,
): Principal {
  if (!record) return { kind: "anonymous" };
  if (verdict === "revoked")
    return { kind: "revoked", machineId: record.machineId, name: record.name };
  return {
    kind: "machine",
    machineId: record.machineId,
    userId: record.userId,
    name: record.name,
    owner: record.owner,
  };
}

/**
 * The session as it stands, asking the control plane when the answer is stale.
 *
 * A `userId` learned here is written back: revocation and identity both live on
 * the server, and persisting the id is what keeps the principal complete the
 * next time this app starts with no network.
 */
export async function currentSession(): Promise<RedactedSession> {
  const record = await readRecord();
  const apiUrl = api.resolveApi(record?.apiUrl);
  if (!record) return anonymousSession(apiUrl);

  const { verdict, userId, owner } = await api.probeIfStale(record);
  // Written back when either moved: identity lives on the server, and keeping a
  // local copy is what lets the account screen say something offline.
  if (userId !== record.userId || owner !== record.owner)
    await writeRecord({ ...record, userId, owner });

  const { checkedAt } = api.cachedVerdict();
  return {
    principal: principalOf({ ...record, userId, owner }, verdict),
    apiUrl,
    verdict,
    checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
  };
}

/**
 * The part of a session the gate reacts to.
 *
 * ⚠️ Excludes `checkedAt`, which moves on every single probe — keying on the
 * whole object would make each beat look like a change and push a pointless
 * re-render to every window once a minute.
 */
function sessionKey(session: RedactedSession): string {
  return JSON.stringify({
    principal: session.principal,
    verdict: session.verdict,
  });
}

/** Recompute the session and push it to every window. */
async function publish(): Promise<RedactedSession> {
  const session = await currentSession();
  lastPublished = sessionKey(session);
  broadcast(authChannels.changed, session);
  return session;
}

/** One beat: re-probe, and push only when the session actually moved. */
async function beat(): Promise<void> {
  try {
    const record = await readRecord();
    // Nothing to probe, and an anonymous session cannot change on its own —
    // only a sign-in changes it, and that publishes for itself.
    if (!record) return;

    // Forced, not `probeIfStale`: the cache exists to absorb bursts of reads,
    // and a beat is exactly the thing that should go and look.
    await api.probe(record);

    const session = await currentSession();
    const key = sessionKey(session);
    if (key === lastPublished) return;
    lastPublished = key;
    broadcast(authChannels.changed, session);
  } catch {
    // A failed beat is a missed beat, never an unhandled rejection in main.
    // The next one asks again, and `probe` already reports its own failures
    // as `unreachable` rather than throwing.
  }
}

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => void beat(), heartbeatMs());
  // Never let this timer be the reason the process stays alive.
  heartbeat.unref?.();
}

function emitProgress(progress: SignInProgress): void {
  broadcast(authChannels.progress, progress);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("Sign-in cancelled."));
    });
  });
}

/** Store what the control plane issued, and report the session it produces. */
async function accept(
  apiUrl: string,
  issued: { machineId: string; secret: string },
  name: string,
): Promise<RedactedSession> {
  api.resetVerdict();
  await writeRecord({
    machineId: issued.machineId,
    secret: issued.secret,
    apiUrl,
    name,
    userId: null,
    // Both arrive on the first probe; `accept` publishes, which triggers one.
    owner: null,
  });
  // FE-28: a hook that was left on through a sign-out gets the new credential.
  void syncHandoff().catch(() => undefined);
  return publish();
}

async function signInLoopback(
  apiUrl: string,
  signal: AbortSignal,
): Promise<RedactedSession> {
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const facts = api.machineFacts();

  const code = await listenForCallback({
    state,
    signal,
    onPort: async (port) => {
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      // An assertion on our own port picking, before the control plane pins the
      // redirect at creation and can no longer be corrected.
      if (!parseLoopbackRedirect(redirectUri))
        throw new Error(
          `Refusing to register an unsafe redirect: ${redirectUri}`,
        );

      const started = await api.startLoopback(
        apiUrl,
        { challenge, state, redirectUri, facts },
        signal,
      );
      // Emitted BEFORE the browser is opened, so the URL is on screen even when
      // `openExternal` silently does nothing — the failure mode is a window that
      // just sits there, and a visible URL turns it into a click.
      emitProgress({
        mode: "loopback",
        authorizeUrl: started.authorizeUrl,
        port,
      });
      await shell.openExternal(started.authorizeUrl).catch(() => {});
    },
  });

  const outcome = await api.redeem(apiUrl, { code }, verifier, signal);
  if (outcome.state === "denied")
    throw new Error(
      "The sign-in was denied in the browser. Nothing was connected.",
    );
  if (outcome.state !== "issued")
    throw new Error("The sign-in expired before it was approved. Try again.");
  return accept(apiUrl, outcome, facts.name);
}

async function signInDevice(
  apiUrl: string,
  signal: AbortSignal,
): Promise<RedactedSession> {
  const { verifier, challenge } = pkcePair();
  const facts = api.machineFacts();
  const started = await api.startDevice(apiUrl, { challenge, facts }, signal);

  emitProgress({
    mode: "device",
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    interval: started.interval,
  });
  await shell.openExternal(started.verificationUriComplete).catch(() => {});

  // Polls at the interval the SERVER asks for and backs off when it says
  // `slow_down`; ignoring that gets the poll refused rather than answered.
  let interval = started.interval;
  const deadline = Date.now() + DEVICE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal);
    const outcome = await api.redeem(
      apiUrl,
      { deviceCode: started.deviceCode },
      verifier,
      signal,
    );
    if (outcome.state === "issued") return accept(apiUrl, outcome, facts.name);
    if (outcome.state === "denied")
      throw new Error("The sign-in was denied. Nothing was connected.");
    if (outcome.state === "expired")
      throw new Error("The code expired before it was approved. Try again.");
    if (outcome.state === "slow_down") interval += 5;
  }
  throw new Error("Timed out waiting for approval. Nothing was changed.");
}

/** Start a sign-in. Resolves with the session it produced, or throws. */
export async function signIn(
  mode: SignInMode = "loopback",
): Promise<RedactedSession> {
  const session = await currentSession();
  if (!can(session.principal, "session:signIn"))
    throw new Error(
      "This machine is already signed in. Sign out first — re-enrolling would leave a second live machine on the account.",
    );
  if (inFlight) throw new Error("A sign-in is already in progress.");

  // Env or the built-in default, never a record's stored origin: a revoked
  // record may name a control plane this install no longer targets.
  const apiUrl = api.resolveApi();

  const controller = new AbortController();
  inFlight = controller;
  try {
    return mode === "device"
      ? await signInDevice(apiUrl, controller.signal)
      : await signInLoopback(apiUrl, controller.signal);
  } finally {
    inFlight = null;
  }
}

/**
 * Sign out: revoke on the control plane, then drop the local credential.
 *
 * The revoke is best effort and the local delete happens either way — a network
 * failure must not strand someone who asked to sign out. The consequence is
 * stated plainly rather than hidden: an unreachable control plane keeps the
 * machine listed until it is revoked from a browser.
 */
export async function signOut(): Promise<RedactedSession> {
  const session = await currentSession();
  if (!can(session.principal, "session:signOut")) return session;

  const record = await readRecord();
  if (record && can(session.principal, "machine:revokeSelf"))
    await api.revokeSelf(record);

  await clearRecord();
  // FE-28: the Stop hook's copy of the credential goes with it.
  if (record) await forgetHookCredential(record.apiUrl);
  api.resetVerdict();
  return publish();
}

/** Abort an in-flight sign-in. A no-op when none is running. */
export function cancelSignIn(): void {
  inFlight?.abort();
  inFlight = null;
}

function parseMode(value: unknown): SignInMode {
  if (value === undefined || value === "loopback") return "loopback";
  if (value === "device") return "device";
  throw new Error('mode must be "loopback" or "device"');
}

/** Wire the auth channels. Every handler validates its sender via `handle`. */
export function registerAuth(devUrl?: string): void {
  handle(authChannels.session, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return currentSession();
  });
  handle(authChannels.signIn, devUrl, (args) => {
    if (args.length > 1) throw new Error("This operation takes one argument");
    return signIn(parseMode(args[0]));
  });
  handle(authChannels.signOut, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return signOut();
  });
  handle(authChannels.cancel, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    cancelSignIn();
  });
  startHeartbeat();
}
