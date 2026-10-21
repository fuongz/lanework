// Where the checkpoint hook keeps this machine's credential, for every way it
// is installed: the desktop app (FE-28), the Claude Code plugin (INF-03), or by
// hand.
//
//   • macOS: the Keychain item `dev.lanework.checkpoint-hook`, account = the
//     API URL. The desktop app writes the same item, so the app and the plugin
//     share one credential on one machine.
//   • Linux (INF-03/D5): `$XDG_CONFIG_HOME/lanework/credential`, mode 0600.
//   • `LANEWORK_HOOK_SECRET_FILE` overrides both — tests, and machines with no
//     Keychain.
//
// ⚠️ The secret reaches `security` on STDIN (`security -i`), never in argv,
// where every process on the machine can read it from the process list.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";

/** `$XDG_CONFIG_HOME/lanework`, or `~/.config/lanework`. */
export function configDir(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "lanework",
  );
}

/** The file the secret lives in when it does not live in the Keychain. */
function secretFile(): string | null {
  if (process.env.LANEWORK_HOOK_SECRET_FILE)
    return process.env.LANEWORK_HOOK_SECRET_FILE;
  return process.platform === "darwin" ? null : join(configDir(), "credential");
}

/** Where the credential is kept, for `lanework status` to say. */
export function credentialLocation(): string {
  return secretFile() ?? `macOS Keychain (${KEYCHAIN_SERVICE})`;
}

export function readSecret(api: string): string | null {
  const file = secretFile();
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
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

export function writeSecret(api: string, secret: string): void {
  const file = secretFile();
  if (file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return;
  }
  execFileSync("security", ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${api}" -w "${secret}"\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

export function deleteSecret(api: string): void {
  const file = secretFile();
  if (file) {
    rmSync(file, { force: true });
    return;
  }
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", api],
      { stdio: "ignore" },
    );
  } catch {
    // Nothing stored: already signed out.
  }
}
