import type { Principal, RedactedSession } from "./auth";

/**
 * Everything a caller can ask to do. A closed vocabulary: each action is read
 * by exactly one gate, so a free-form string would only ever name a permission
 * nothing consults.
 */
export const ACTIONS = [
  /** Use the app at all. The one question the UI gate and main both ask. */
  "app:use",
  "session:read",
  "session:signIn",
  "session:signOut",
  "machine:self",
  "machine:revokeSelf",
  "machine:enrol",
  "machine:revokeAny",
  /**
   * FE-52/D10: anything that only exists on the control plane — comments,
   * presence, attachments, subscriptions, handing work between agents, sync.
   * A `local` principal can use the app but not these.
   */
  "cloud:use",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * May `principal` perform `action`?
 *
 * Pure and total, so main can enforce it authoritatively on every IPC handler
 * and the renderer can call the same function to hide what would be refused.
 * The renderer's answer is a convenience; main's is the decision.
 *
 * `machine:enrol` and `machine:revokeAny` are false for EVERY principal, and
 * that is the ported rule rather than an omission: enrolling a machine or
 * revoking someone else's is a human's job, held behind a browser session this
 * app never has. A machine credential that could enrol more machines would turn
 * one stolen credential into permanent access.
 */
export function can(principal: Principal, action: Action): boolean {
  switch (action) {
    case "app:use":
      // Only a credential the control plane still accepts opens the app. Being
      // OFFLINE is not being locked out: `unreachable` keeps the principal a
      // `machine` (BE-01 D8), so an enrolled install keeps working — see
      // `lockState` for why that is the whole of FE-01's O1.
      //
      // FE-52/D5: `local` — "Skip for now" — opens it too, on the SQLite board
      // this machine keeps. It holds no credential, so every cloud-only action
      // below stays closed to it (`cloud:use`).
      return principal.kind === "machine" || principal.kind === "local";
    case "session:read":
      return true;
    case "session:signIn":
      // A revoked machine may sign in again; a working one must sign out first,
      // or it would silently leave a second live machine on the account.
      return principal.kind !== "machine";
    case "session:signOut":
      // Allowed while anything is on disk, revoked or not — that is what there
      // is to clean up.
      return principal.kind !== "anonymous";
    case "machine:self":
    case "machine:revokeSelf":
      // A credential the other side has stopped accepting can do neither.
      return principal.kind === "machine";
    case "machine:enrol":
    case "machine:revokeAny":
      return false;
    case "cloud:use":
      return principal.kind === "machine";
  }
}

/** Why the app is closed, or that it is open. */
export type LockState =
  | { locked: false }
  | { locked: true; reason: "signed-out" }
  | { locked: true; reason: "revoked"; machineName: string };

/**
 * Whether this session may use the app, and what to say when it may not.
 *
 * Derived from `can(…, "app:use")` rather than from `principal.kind` directly,
 * so the gate and main cannot drift apart: there is one rule and two readers.
 *
 * ⚠️ There is deliberately no "unreachable" lock. Two separate reasons:
 *   • An ENROLLED install that loses the network keeps working (O1). Locking it
 *     would trade a risk we do not carry — the data is local — for a failure we
 *     meet constantly.
 *   • An install that has NEVER enrolled cannot be `unreachable` at all: nothing
 *     probes without a credential, so its verdict is `null`. "Cannot reach the
 *     control plane" therefore reaches the user as a FAILED SIGN-IN, which is
 *     where it actually happens, not as a lock reason.
 */
export function lockState(session: RedactedSession): LockState {
  if (can(session.principal, "app:use")) return { locked: false };
  return session.principal.kind === "revoked"
    ? { locked: true, reason: "revoked", machineName: session.principal.name }
    : { locked: true, reason: "signed-out" };
}
