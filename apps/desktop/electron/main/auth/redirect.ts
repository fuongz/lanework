// Where a URL is allowed to point, in both directions of the loopback hop.
//
// Dependency-free so the rejection matrix can be exercised without booting
// Electron. A validator that is awkward to test is one nobody re-tests after
// editing it.

import { LOOPBACK_CALLBACK_PATH } from "@lanework/protocol";

/** The one path our loopback listener answers. */
export const CALLBACK_PATH = LOOPBACK_CALLBACK_PATH;

/** Binding a privileged port needs root, so a redirect there cannot be ours. */
const MIN_PORT = 1024;

/**
 * Validate a loopback `redirect_uri`, returning it normalized or `null`.
 *
 * Accepted: `http://127.0.0.1:<1024-65535>/oauth/callback`, and nothing else.
 *
 * We build this URI ourselves, so this is an assertion on our own port picking
 * rather than input validation. It fires before the URI is handed to the
 * control plane, which pins the redirect at creation and cannot correct it.
 *
 * NOTE: `localhost` is refused even though it looks like the safest value:
 * - it goes through a resolver, so one line in `/etc/hosts` or a hostile DNS
 *   server makes it somebody else's address;
 * - it is ambiguous between `127.0.0.1` and `::1`, so the listener may bind
 *   one while the browser picks the other, a failure that reads as a hung
 *   login rather than a bad name.
 */
export function parseLoopbackRedirect(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 256) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1") return null;
  if (url.pathname !== CALLBACK_PATH) return null;
  // Credentials in the authority, or anything after the path, would survive
  // into the URI the control plane stores. Refuse rather than strip: a caller
  // that sent one has a bug, and silently repairing it hides the bug.
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;

  // `url.port` is "" for the default port 80, which is privileged, so an empty
  // port is a rejection here rather than a value to default.
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < MIN_PORT || port > 65535) return null;

  return url;
}

/**
 * The URL we are willing to hand to the system browser, or `null`.
 *
 * The control plane tells us where to send the user, and that value ends up
 * in `shell.openExternal`, so it is checked against the origin we asked, not
 * merely parsed.
 *
 * NOTE: A misconfigured or hostile control plane must not be able to open
 * `file:///…` or somebody else's site through our window.
 */
export function externalUrlOn(raw: unknown, origin: string): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;

  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(origin);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.origin !== base.origin) return null;
  return url.toString();
}

/** The alphabet the control plane mints device codes from: no `0 O 1 I L`. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * True when `value` has the `XXXX-XXXX` shape of a device user code.
 *
 * Checked before the code is shown to anyone: a response that does not carry
 * a real code has to fail loudly here rather than put an unusable string on
 * screen and leave the user retyping it.
 */
export function looksLikeUserCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 9) return false;
  if (value[4] !== "-") return false;
  return [...value.replace("-", "")].every((c) =>
    USER_CODE_ALPHABET.includes(c),
  );
}
