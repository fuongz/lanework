import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import {
  type JevConfig,
  type JudgeLogEntry,
  parseJevConfig,
} from "../../../shared/orchestration";

// Jev's state on disk, under the app's userData:
//
// - `jev/config.json`: the config, checked on every read.
// - `jev/key.bin`: the provider's API key, encrypted with `safeStorage`.
// - `jev/log.json`: the newest LOG_MAX answers, without their context.
//
// NOTE: The key is never written in clear. Where the OS cannot encrypt it,
// it is refused rather than kept: a third-party key in a plain file is worse
// than asking the user to set it again.

/** How many answers the log keeps. */
export const LOG_MAX = 500;

/** Jev's defaults: off, every point in shadow (D14). */
export const DEFAULT_CONFIG: JevConfig = {
  provider: null,
  endpoint: "",
  model: "",
  points: {
    "model-tier": { mode: "shadow", threshold: 0.85 },
    permission: { mode: "shadow", threshold: 0.85 },
    report: { mode: "shadow", threshold: 0.85 },
  },
  tiers: {
    light: { agent: "claude", model: "claude-haiku-5-5", effort: "low" },
    standard: { agent: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    heavy: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  },
};

function dir(): string {
  return join(app.getPath("userData"), "jev");
}

const file = (name: string) => join(dir(), name);

/** Write `text` whole or not at all: a crash mid-write leaves the old file. */
async function writeAtomic(path: string, text: string | Buffer): Promise<void> {
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, path);
}

/** The kept config; the defaults when none is kept or it no longer parses. */
export async function readConfig(): Promise<JevConfig> {
  const raw = await readFile(file("config.json"), "utf8").catch(() => null);
  if (raw === null) return structuredClone(DEFAULT_CONFIG);
  try {
    return parseJevConfig(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function writeConfig(config: JevConfig): Promise<void> {
  await writeAtomic(
    file("config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

/**
 * The kept API key, decrypted; null when none is kept or it cannot be read.
 *
 * NOTE: Callers hand it to `fetch` and nowhere else.
 */
export async function readKey(): Promise<string | null> {
  const data = await readFile(file("key.bin")).catch(() => null);
  if (!data || data.length === 0) return null;
  try {
    return safeStorage.decryptString(data) || null;
  } catch {
    // The Keychain entry is gone or belongs to another install.
    return null;
  }
}

export async function hasKey(): Promise<boolean> {
  return (await readKey()) !== null;
}

/**
 * Keep or forget the key.
 *
 * @throws When the OS cannot encrypt it.
 */
export async function writeKey(key: string | null): Promise<void> {
  if (key === null) {
    await rm(file("key.bin"), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      "This system cannot encrypt the key, so Lanework will not keep it.",
    );
  await writeAtomic(file("key.bin"), safeStorage.encryptString(key));
}

function isEntry(value: unknown): value is JudgeLogEntry {
  const entry = value as JudgeLogEntry;
  return (
    !!entry &&
    typeof entry.id === "string" &&
    typeof entry.at === "number" &&
    typeof entry.question === "string" &&
    Array.isArray(entry.options)
  );
}

let log: JudgeLogEntry[] | null = null;
/** Every log write, in order: two answers at once must not drop one. */
let queue: Promise<unknown> = Promise.resolve();

async function loadLog(): Promise<JudgeLogEntry[]> {
  if (log) return log;
  const raw = await readFile(file("log.json"), "utf8").catch(() => null);
  let entries: JudgeLogEntry[] = [];
  if (raw !== null)
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter(isEntry);
    } catch {
      entries = [];
    }
  log = entries.slice(-LOG_MAX);
  return log;
}

function mutateLog(
  change: (entries: JudgeLogEntry[]) => JudgeLogEntry[] | null,
): Promise<void> {
  const next = queue.then(async () => {
    const entries = change(await loadLog());
    if (!entries) return;
    log = entries.slice(-LOG_MAX);
    await writeAtomic(file("log.json"), JSON.stringify(log));
  });
  // A failed write must not wedge every later one.
  queue = next.catch(() => {});
  return next;
}

export function appendLog(entry: JudgeLogEntry): Promise<void> {
  return mutateLog((entries) => [...entries, entry]);
}

/** Record what was done in the end. An unknown id is ignored. */
export function settleLog(id: string, outcome: string): Promise<void> {
  return mutateLog((entries) => {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const copy = entries.slice();
    copy[index] = { ...copy[index], outcome };
    return copy;
  });
}

/** The newest entries first. */
export async function readLog(): Promise<JudgeLogEntry[]> {
  await queue;
  return (await loadLog()).slice().reverse();
}
