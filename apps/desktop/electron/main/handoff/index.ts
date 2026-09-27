// Settings → Agents (FE-28): switch the checkpoint Stop hook (BE-17) on and
// off for Claude Code on this machine, with no terminal and no token to paste.
//
// On: the hook goes into `~/.claude/settings.json` (user level, so every repo
// gets it) and this machine's credential goes into the Keychain item the hook
// reads. Off: both are removed, and nothing else in the file is touched.
//
// ⚠️ The command names absolute paths — this app's binary and the bundled
// hook — and those move when the app is updated or dragged elsewhere. So an
// installed hook is REWRITTEN on every launch (`syncHandoff`), and a stale one
// never outlives the next start.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { type HandoffStatus, handoffChannels } from "../../../shared/handoff";
import { resolveApi } from "../auth/client";
import { type MachineRecord, readRecord } from "../auth/store";
import { handle } from "../ipc";
import {
  buildHookCommand,
  claudeSettingsPath,
  findHook,
  readSettings,
  withHook,
  withoutHook,
  writeSettings,
} from "./claude-settings";
import {
  deleteHookSecret,
  readHookSecret,
  secretStoreAvailable,
  writeHookSecret,
} from "./secret";

/** Where the hook keeps its per-session state — named in the hook too. */
const HOOK_STATE_DIR = join(homedir(), ".cache", "lanework", "checkpoint");

/**
 * The bundled hook, outside the asar archive.
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` is a plain Node, which cannot read a path inside
 * `app.asar`. `electron-builder.yml` unpacks `dist/electron/hook/**` for that,
 * and the path here points at the unpacked copy. Unpackaged (dev, tests) there
 * is no archive and the path is left as it is.
 */
function hookPath(): string {
  return join(__dirname, "..", "hook", "lanework-checkpoint.cjs").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

function commandFor(record: MachineRecord | null, pushWip: boolean): string {
  return buildHookCommand({
    execPath: process.execPath,
    hookPath: hookPath(),
    apiUrl: resolveApi(record?.apiUrl),
    pushWip,
    secretFile: process.env.LANEWORK_HOOK_SECRET_FILE || null,
  });
}

/** The newest session the hook recorded, from its own state files. */
async function lastCheckpoint(): Promise<HandoffStatus["last"]> {
  const names = await readdir(HOOK_STATE_DIR).catch(() => [] as string[]);
  let best: { taskId: string; at: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
    const state = await readFile(join(HOOK_STATE_DIR, name), "utf8")
      .then((text) => JSON.parse(text) as { at?: unknown; taskId?: unknown })
      .catch(() => null);
    if (typeof state?.at !== "number" || typeof state.taskId !== "string")
      continue;
    if (!best || state.at > best.at)
      best = { taskId: state.taskId, at: state.at };
  }
  return best
    ? { taskId: best.taskId, at: new Date(best.at).toISOString() }
    : null;
}

export async function handoffStatus(): Promise<HandoffStatus> {
  const record = await readRecord();
  const read = await readSettings();
  const command = read.ok ? findHook(read.settings) : null;
  const stored = record
    ? await readHookSecret(resolveApi(record.apiUrl))
    : null;
  return {
    supported: secretStoreAvailable(),
    signedIn: record !== null,
    installed: command !== null,
    credential: !!record && stored === record.secret,
    pushWip: command?.includes("--push-wip") ?? false,
    settingsUnreadable: !read.ok,
    settingsPath: claudeSettingsPath(),
    last: await lastCheckpoint(),
  };
}

async function install(pushWip: boolean): Promise<HandoffStatus> {
  if (!secretStoreAvailable())
    throw new Error("Handing work between agents needs macOS for now.");
  const record = await readRecord();
  if (!record) throw new Error("Sign in first, so the hook has a credential.");
  const read = await readSettings();
  if (!read.ok)
    throw new Error(
      `${claudeSettingsPath()} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
    );
  await writeHookSecret(resolveApi(record.apiUrl), record.secret);
  await writeSettings(withHook(read.settings, commandFor(record, pushWip)));
  return handoffStatus();
}

export async function disableHandoff(): Promise<HandoffStatus> {
  const record = await readRecord();
  const read = await readSettings();
  if (read.ok && findHook(read.settings) !== null)
    await writeSettings(withoutHook(read.settings));
  await deleteHookSecret(resolveApi(record?.apiUrl));
  return handoffStatus();
}

/**
 * The credential is gone from this machine (sign-out): take the hook's copy
 * with it. The hook stays installed and says "no credential" in its log until
 * someone signs in again, when `syncHandoff` hands it the new one.
 */
export async function forgetHookCredential(apiUrl: string): Promise<void> {
  await deleteHookSecret(resolveApi(apiUrl)).catch(() => undefined);
}

/**
 * Bring an installed hook up to date: this binary's path, this build's hook,
 * this machine's current credential. A no-op when the switch is off.
 */
export async function syncHandoff(): Promise<void> {
  if (!secretStoreAvailable()) return;
  const read = await readSettings();
  if (!read.ok) return;
  const current = findHook(read.settings);
  if (current === null) return;
  const record = await readRecord();
  const wanted = commandFor(record, current.includes("--push-wip"));
  if (wanted !== current) await writeSettings(withHook(read.settings, wanted));
  if (!record) return;
  const account = resolveApi(record.apiUrl);
  if ((await readHookSecret(account)) !== record.secret)
    await writeHookSecret(account, record.secret);
}

export function registerHandoff(devUrl?: string): void {
  handle(handoffChannels.status, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return handoffStatus();
  });
  // FE-28/D3: pushing unfinished code is opt-in, so switching on never does.
  handle(handoffChannels.enable, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return install(false);
  });
  handle(handoffChannels.disable, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return disableHandoff();
  });
  handle(handoffChannels.setPushWip, devUrl, async (args) => {
    if (args.length !== 1 || typeof args[0] !== "boolean")
      throw new Error("push-wip takes one boolean");
    const status = await handoffStatus();
    if (!status.installed)
      throw new Error("Turn on handing work between agents first.");
    return install(args[0]);
  });
  void syncHandoff().catch((error: unknown) =>
    console.warn("could not bring the Claude Code hook up to date", error),
  );
}
