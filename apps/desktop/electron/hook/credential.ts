// Where the checkpoint hook keeps this machine's credential, for every way it
// is installed: the desktop app, the Claude Code plugin, or by hand.
//
// - macOS: the Keychain item `dev.lanework.checkpoint-hook`, account = the
//   API URL. The desktop app writes the same item, so the app and the plugin
//   share one credential on one machine.
// - Linux (INF-03/D5): `$XDG_CONFIG_HOME/lanework/credential`, mode 0600, for
//   the default API; `credential-<hash of the API origin>` for any other one,
//   so a credential for one API is never sent to another (FE-78/D6).
// - `LANEWORK_HOOK_SECRET_FILE` overrides both: for tests, and for machines
//   with no Keychain.
//
// NOTE: The secret reaches `security` on stdin (`security -i`), never in
// argv, where every process on the machine can read it from the process list.
// That line is quoted, so a secret or API with a quote, a backslash or a
// control character in it is refused rather than written (FE-78/D1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_API_ORIGIN } from "@lanework/protocol";

const KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";
/** By absolute path: a `security` earlier on PATH never sees the secret. */
const SECURITY = "/usr/bin/security";

/** `$XDG_CONFIG_HOME/lanework`, or `~/.config/lanework`. */
export function configDir(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "lanework",
  );
}

/** `api`'s origin, or `api` itself when it is not a URL. */
function originOf(api: string): string {
  try {
    return new URL(api).origin;
  } catch {
    return api;
  }
}

/**
 * The file the secret lives in when it does not live in the Keychain.
 *
 * Keyed by the API's origin. The default API keeps the plain `credential`
 * name, so a machine signed in before the key existed stays signed in.
 */
function secretFile(api: string): string | null {
  if (process.env.LANEWORK_HOOK_SECRET_FILE)
    return process.env.LANEWORK_HOOK_SECRET_FILE;
  if (process.platform === "darwin") return null;
  const origin = originOf(api);
  if (origin === DEFAULT_API_ORIGIN) return join(configDir(), "credential");
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return join(configDir(), `credential-${key}`);
}

/** Where the credential is kept, for `lanework status` to say. */
export function credentialLocation(api: string): string {
  return secretFile(api) ?? `macOS Keychain (${KEYCHAIN_SERVICE})`;
}

/** Whether `value` holds a quote, a backslash or a control character. */
function unsafe(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '"' || char === "\\" || code < 0x20 || code === 0x7f)
      return true;
  }
  return false;
}

function assertSafe(what: string, value: string): void {
  if (!value || unsafe(value))
    throw new Error(`Refusing to store a ${what} with unsafe characters.`);
}

export function readSecret(api: string): string | null {
  const file = secretFile(api);
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  try {
    return (
      execFileSync(
        SECURITY,
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

export function writeSecret(api: string, secret: string): void {
  assertSafe("credential", secret);
  const file = secretFile(api);
  if (file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return;
  }
  assertSafe("API address", api);
  execFileSync(SECURITY, ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${api}" -w "${secret}"\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

export function deleteSecret(api: string): void {
  const file = secretFile(api);
  if (file) {
    rmSync(file, { force: true });
    return;
  }
  try {
    execFileSync(
      SECURITY,
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api],
      { stdio: "ignore" },
    );
  } catch {
    // Nothing stored: already signed out.
  }
}
