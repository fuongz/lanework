import type { Principal } from "./auth";

/**
 * Everything a caller can ask to do. A closed vocabulary: each action is read
 * by exactly one gate, so a free-form string would only ever name a permission
 * nothing consults.
 */
export const ACTIONS = [
  "session:read",
  "session:signIn",
  "session:signOut",
  "machine:self",
  "machine:revokeSelf",
  "machine:enrol",
  "machine:revokeAny",
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
  }
}
