import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { AccountOwner } from "../../../shared/auth";
import { appHomeDir } from "../paths";

/**
 * This install's control-plane identity.
 *
 * NOTE: `secret` is never logged or returned.
 */
export interface MachineRecord {
  machineId: string;
  secret: string;
  apiUrl: string;
  name: string;
  /** Learned from `/v1/machines/me`; kept so the principal survives offline. */
  userId: string | null;
  /**
   * Learned from `/v1/machines/me`, like `userId`.
   *
   * Kept so a settings screen does not go blank offline.
   */
  owner: AccountOwner | null;
}

/**
 * The record's shape in `auth.json`.
 *
 * The secret is encrypted whenever the OS will do it for us.
 */
type Stored = {
  v: 1;
  machineId: string;
  apiUrl: string;
  name: string;
  userId: string | null;
  owner: AccountOwner | null;
} & ({ enc: true; secretEnc: string } | { enc: false; secret: string });

function credentialFile(): string {
  return join(appHomeDir(), "auth.json");
}

/**
 * Whether `safeStorage` really encrypts on this machine (FE-78/D11).
 *
 * On Linux with no keyring Electron reports encryption as available but uses
 * its `basic_text` backend, a fixed key compiled into every copy of Chromium.
 * That is plaintext with extra steps, so it counts as unavailable, and the
 * credential is stored as `enc: false` where Settings can say so.
 */
export function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    try {
      if (safeStorage.getSelectedStorageBackend() === "basic_text")
        return false;
    } catch {
      // Older Electron, or called before `ready`: trust the first answer.
    }
  }
  return true;
}

/** A stored credential and how it is kept on disk. */
export interface StoredRecord {
  record: MachineRecord;
  /** False when `auth.json` holds the secret in plaintext. */
  encrypted: boolean;
}

/**
 * The stored credential and whether it is encrypted, or `null` when this
 * install has never signed in.
 *
 * A plaintext record (written while encryption was unavailable) is
 * re-encrypted in place the first time it is read with encryption available
 * (FE-78/D11), and then reads as encrypted.
 */
export async function readStoredRecord(): Promise<StoredRecord | null> {
  const raw = await readFile(credentialFile(), "utf8").catch(() => null);
  if (raw === null) return null;

  let data: Stored;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data?.v !== 1 || !data.machineId || !data.apiUrl) return null;

  let secret: string;
  if (data.enc) {
    if (typeof data.secretEnc !== "string") return null;
    try {
      secret = safeStorage.decryptString(Buffer.from(data.secretEnc, "base64"));
    } catch {
      // The keychain entry is gone or belongs to another install. Nothing here
      // can recover it, and a signed-out app is the honest outcome.
      return null;
    }
  } else {
    if (typeof data.secret !== "string" || !data.secret) return null;
    secret = data.secret;
  }

  const record: MachineRecord = {
    machineId: data.machineId,
    secret,
    apiUrl: data.apiUrl,
    name: data.name ?? "",
    userId: data.userId ?? null,
    owner: data.owner ?? null,
  };
  if (data.enc) return { record, encrypted: true };
  return { record, encrypted: await reencrypt(raw, record) };
}

/**
 * The stored credential, or `null` when this install has never signed in.
 *
 * Anything unreadable (missing, malformed, undecryptable) reads as `null`. A
 * credential we cannot use is no better than one we do not have, and treating
 * the two alike keeps every caller on one path.
 */
export async function readRecord(): Promise<MachineRecord | null> {
  return (await readStoredRecord())?.record ?? null;
}

/**
 * Rewrite a plaintext record encrypted, once encryption is available.
 *
 * NOTE: Only when `auth.json` still holds exactly what was read. A sign-out
 * that deleted the file in between must not have the credential written back.
 *
 * @returns Whether the record is now encrypted on disk.
 */
async function reencrypt(raw: string, record: MachineRecord): Promise<boolean> {
  if (!encryptionAvailable()) return false;
  try {
    const now = await readFile(credentialFile(), "utf8").catch(() => null);
    if (now !== raw) return false;
    await writeRecord(record);
    return true;
  } catch {
    // Best effort: the plaintext record still works, and the next read
    // tries again.
    return false;
  }
}

/**
 * Persist the credential.
 *
 * `chmod` runs after the write, not only as `writeFile`'s `mode`: that mode
 * applies on CREATE, so a file that already exists with looser permissions
 * would silently keep them.
 *
 * @returns The path of the credential file.
 */
export async function writeRecord(record: MachineRecord): Promise<string> {
  const home = appHomeDir();
  await mkdir(home, { recursive: true, mode: 0o700 });

  const base = {
    v: 1 as const,
    machineId: record.machineId,
    apiUrl: record.apiUrl,
    name: record.name,
    userId: record.userId,
    owner: record.owner,
  };
  const stored: Stored = encryptionAvailable()
    ? {
        ...base,
        enc: true,
        secretEnc: safeStorage.encryptString(record.secret).toString("base64"),
      }
    : { ...base, enc: false, secret: record.secret };

  const file = credentialFile();
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600).catch(() => {});
  return file;
}

/**
 * Forget this machine locally.
 *
 * Revoking it on the server is a separate step.
 */
export async function clearRecord(): Promise<void> {
  await rm(credentialFile(), { force: true }).catch(() => {});
}
