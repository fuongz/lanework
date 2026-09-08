import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";
import { appHomeDir } from "../paths";

/** Include the origin so identical IDs on another control plane cannot share state. */
function activeFile(record: MachineRecord): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        resolveApi(record.apiUrl),
        record.userId,
        record.machineId,
      ]),
    )
    .digest("hex");
  return join(appHomeDir(), "workspaces", `${key}.json`);
}

export async function readActive(
  record: MachineRecord,
): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(activeFile(record), "utf8"));
    return data?.v === 1 && typeof data.active === "string"
      ? data.active
      : null;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw new Error("Could not read your workspace selection. Try again.");
  }
}

export async function writeActive(
  record: MachineRecord,
  active: string | null,
): Promise<void> {
  const file = activeFile(record);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(appHomeDir(), "workspaces"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(temporary, JSON.stringify({ v: 1, active }), {
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch {
    throw new Error("Could not save your workspace selection. Try again.");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
