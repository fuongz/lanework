import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appHomeDir } from "../paths";
import {
  type RememberedTrust,
  type RepoTrustScan,
  scanRepoTrust,
  type TrustAnswer,
  type TrustFinding,
  TrustStore,
  trustFingerprint,
} from "./repo-trust";

/**
 * The one decision every automatic git read of a linked folder goes through
 * (FE-77, D6 / GAP-01).
 *
 * Status on project open, the rail badge, the instructions and memory readers
 * and file suggestions all read a folder without a click. {@link readsAllowed}
 * scans the folder's own git config and hooks first. A folder with nothing
 * risky reads as before; a risky one is asked about once, through the asker
 * main installs with {@link setTrustAsker}, and the answer is remembered
 * against those exact findings, so a hook added later asks again.
 *
 * - Electron-free: main supplies the native dialog. With no asker installed
 *   (the hook, a unit run) a risky folder is refused, never run.
 * - Answers live in `~/.lanew/repo-trust.json`. Not under `~/.lanew/git/`,
 *   which `removeLegacyStore` deletes at every start.
 * - User-initiated writes (commit, push, pull, switch) are not gated here:
 *   the user asked for them, and they keep the user's own hooks.
 */

/** Asks the user about one risky folder; resolves with their answer. */
export type TrustAsker = (
  folder: string,
  scan: RepoTrustScan,
) => Promise<TrustAnswer>;

/** How long a "run" verdict stands before the folder is scanned again. */
const FRESH_MS = 60_000;

let asker: TrustAsker | null = null;
let store: Promise<TrustStore> | null = null;
const fresh = new Map<string, number>();
const pending = new Map<string, Promise<ReadVerdict>>();

function storeFile(): string {
  return join(appHomeDir(), "repo-trust.json");
}

async function save(all: Record<string, RememberedTrust>): Promise<void> {
  const file = storeFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

function load(): Promise<TrustStore> {
  store ??= readFile(storeFile(), "utf8")
    .then((text) => JSON.parse(text) as Record<string, RememberedTrust>)
    .catch(() => ({}))
    .then(
      (initial) =>
        new TrustStore(initial, (all) => {
          save(all).catch(() => {});
        }),
    );
  return store;
}

/** Install the prompt main shows for a risky folder. */
export function setTrustAsker(next: TrustAsker | null): void {
  asker = next;
}

/**
 * Whether the app may read `folder` with git on its own.
 *
 * Concurrent calls for one folder share one scan and at most one prompt.
 * Never throws: a scan that fails counts as not allowed.
 */
export async function readsAllowed(folder: string): Promise<boolean> {
  return (await readsVerdict(folder)) === "run";
}

/**
 * Why an automatic read of `folder` may or may not go on (FE-102).
 *
 * - `run`: nothing risky, or the user trusted these exact findings.
 * - `refused`: the user answered "Don't run" to them.
 * - `unchecked`: the scan failed, or there was nobody to ask. The user never
 *   said no, so the screen must not say they did.
 *
 * Concurrent calls for one folder share one scan and at most one prompt.
 * Never throws.
 */
export function readsVerdict(folder: string): Promise<ReadVerdict> {
  const key = resolve(folder);
  const until = fresh.get(key);
  if (until !== undefined && until > Date.now()) return Promise.resolve("run");
  const running = pending.get(key);
  if (running) return running;
  const decided = decide(key)
    .catch((): ReadVerdict => "unchecked")
    .finally(() => pending.delete(key));
  pending.set(key, decided);
  return decided;
}

export type ReadVerdict = "run" | "refused" | "unchecked";

async function decide(folder: string): Promise<ReadVerdict> {
  const trust = await load();
  const verdict = await trust.decide(folder);
  if (verdict.kind === "run") {
    fresh.set(folder, Date.now() + FRESH_MS);
    return "run";
  }
  if (verdict.kind === "restricted") return "refused";
  if (!asker) return "unchecked";
  const answer = await asker(folder, verdict.scan);
  trust.set(folder, answer, verdict.scan);
  if (answer !== "trusted") return "refused";
  fresh.set(folder, Date.now() + FRESH_MS);
  return "run";
}

/**
 * Where a folder's git settings stand, read without asking (FE-102).
 *
 * - `safe`: nothing in them runs a program; nothing to answer.
 * - `allowed` / `refused`: the user's answer to these exact findings.
 * - `unasked`: risky, and not answered (or answered for other findings).
 * - `unchecked`: the scan failed.
 */
export async function trustState(folder: string): Promise<{
  state: "safe" | "allowed" | "refused" | "unasked" | "unchecked";
  findings: TrustFinding[];
}> {
  const key = resolve(folder);
  try {
    const scan = await scanRepoTrust(key);
    if (!scan.risky) return { state: "safe", findings: [] };
    const known = (await load()).get(key);
    const state =
      known && known.fingerprint === trustFingerprint(scan.findings)
        ? known.answer === "trusted"
          ? "allowed"
          : "refused"
        : "unasked";
    return { state, findings: scan.findings };
  } catch {
    return { state: "unchecked", findings: [] };
  }
}

/**
 * Forget the folder's answer and ask the user again, now (FE-102).
 *
 * The native prompt opens at once for a risky folder; a safe one just reads.
 */
export async function askAgain(folder: string): Promise<ReadVerdict> {
  await forgetTrust(folder);
  return readsVerdict(folder);
}

/**
 * Answer "Don't run" for the folder's current findings, without a prompt:
 * Settings' Stop running (FE-102).
 *
 * @returns False when nothing in its git settings runs a program, so there
 *   is nothing to refuse.
 */
export async function restrictTrust(folder: string): Promise<boolean> {
  const key = resolve(folder);
  const scan = await scanRepoTrust(key);
  if (!scan.risky) return false;
  fresh.delete(key);
  (await load()).set(key, "restricted", scan);
  return true;
}

/** Forget a folder's answer, so the next automatic read asks again. */
export async function forgetTrust(folder: string): Promise<void> {
  const key = resolve(folder);
  fresh.delete(key);
  (await load()).forget(key);
}
