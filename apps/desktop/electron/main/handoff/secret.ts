// Where the Stop hook finds this machine's credential (FE-28/D1): the macOS
// Keychain item the hook reads, filled with the credential the app already
// holds — so there is no second machine to enrol, and revoking this machine on
// /setup revokes the hook with it.
//
// ⚠️ The secret reaches `security` on STDIN (`security -i`), never in argv,
// where every process on the machine can read it from the process list.
//
// `LANEWORK_HOOK_SECRET_FILE` swaps the Keychain for a 0600 file. The hook
// honours the same variable, and it is what lets the tests run without
// touching the real Keychain.
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The item the hook looks up — `lanework-checkpoint.ts` names it too. */
export const KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";

const secretFile = () => process.env.LANEWORK_HOOK_SECRET_FILE || null;

/** Whether this machine has somewhere to keep the hook's credential. */
export function secretStoreAvailable(): boolean {
  return process.platform === "darwin" || secretFile() !== null;
}

function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "security",
      args,
      { timeout: 10_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The credential the hook will use, or null. `account` is the API URL. */
export async function readHookSecret(account: string): Promise<string | null> {
  const file = secretFile();
  if (file)
    return (await readFile(file, "utf8").catch(() => "")).trim() || null;
  return security([
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
    "-w",
  ]).catch(() => null);
}

export async function writeHookSecret(
  account: string,
  secret: string,
): Promise<void> {
  const file = secretFile();
  if (file) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return;
  }
  // Double quotes are safe: both are URL-safe base64 or a URL, never a quote.
  await security(
    ["-i"],
    `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -w "${secret}"\n`,
  );
}

export async function deleteHookSecret(account: string): Promise<void> {
  const file = secretFile();
  if (file) {
    await rm(file, { force: true });
    return;
  }
  await security([
    "delete-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
  ]).catch(() => undefined);
}
