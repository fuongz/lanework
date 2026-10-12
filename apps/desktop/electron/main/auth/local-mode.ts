import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appHomeDir } from "../paths";

/**
 * FE-52/D5: whether the person chose "Skip for now" — use the app on the local
 * board, with no account.
 *
 * ⚠️ A file beside `auth.json`, not a field in it. The credential file is
 * rewritten by every sign-in and deleted by every sign-out; the choice to work
 * without an account must survive both, and must never be read as a credential.
 *
 * ⚠️ Electron-free, so the e2e and unit tests can read and write it directly.
 */
function flagFile(): string {
  return join(appHomeDir(), "local-mode.json");
}

/** True when "Skip for now" was chosen and not undone. Unreadable is false. */
export async function readLocalMode(): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(flagFile(), "utf8")) as {
      v?: unknown;
      enabled?: unknown;
    };
    return data?.v === 1 && data.enabled === true;
  } catch {
    return false;
  }
}

export async function writeLocalMode(enabled: boolean): Promise<void> {
  if (!enabled) {
    await rm(flagFile(), { force: true }).catch(() => {});
    return;
  }
  await mkdir(appHomeDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    flagFile(),
    `${JSON.stringify({ v: 1, enabled: true, at: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
