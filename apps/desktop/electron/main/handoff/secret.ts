// Where the Stop hook finds this machine's credential: the macOS Keychain item
// the hook reads, filled with the credential the app already holds (FE-28/D1).
// There is no second machine to enrol, and revoking this machine on `/setup`
// revokes the hook with it.
//
// NOTE: The secret reaches `security` on stdin (`security -i`), never in argv,
// where every process on the machine can read it from the process list.
// `security -i` parses that line as a command line of its own, so a quote, a
// backslash or a newline inside a value would end the argument and start
// another command. Every value is checked before it is written into the line
// (FE-78/D1, SS-03), and `security` is called by its absolute path so a
// `security` earlier on PATH cannot stand in for it.
//
// NOTE (FE-78/SS-07): The item is added with no `-T` access list, so
// `/usr/bin/security`, which created it, can read it back without a prompt.
// That is deliberate: the hook runs `security find-generic-password` in a
// headless Stop hook, where a Keychain prompt would block the agent's turn or
// be dismissed unseen. The cost is that any process running as this user can
// read the hook's copy the same way. It is the same machine credential the
// app holds, revocable from `/setup`, and sign-out deletes this copy.
//
// `LANEWORK_HOOK_SECRET_FILE` swaps the Keychain for a 0600 file. The hook
// honours the same variable, and it is what lets the tests run without
// touching the real Keychain.
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The Keychain item the hook reads. `lanework-checkpoint.ts` names it too. */
const KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";

const SECURITY_BIN = "/usr/bin/security";

const secretFile = () => process.env.LANEWORK_HOOK_SECRET_FILE || null;

/**
 * Whether `value` can sit inside a double-quoted `security -i` argument.
 *
 * Refuses an empty value, a double quote, a backslash and every control
 * character (newline included), which are what end or escape an argument.
 */
export function safeForSecurityLine(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this refuses
  return value.length > 0 && !/["\\\u0000-\u001f\u007f]/.test(value);
}

/** Whether this machine has somewhere to keep the hook's credential. */
export function secretStoreAvailable(): boolean {
  return process.platform === "darwin" || secretFile() !== null;
}

function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      SECURITY_BIN,
      args,
      { timeout: 10_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * The credential the hook will use, or null.
 *
 * @param account The API URL.
 */
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
  if (!safeForSecurityLine(secret))
    throw new Error("Refusing to store a credential that is not well formed.");
  if (!safeForSecurityLine(account))
    throw new Error("Refusing to store a credential for a malformed API URL.");
  const file = secretFile();
  if (file) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return;
  }
  // Double quotes are safe: both values were checked above to hold no quote,
  // no backslash and no control character.
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
