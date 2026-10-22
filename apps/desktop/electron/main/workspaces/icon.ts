// Project icons on this machine: the owner avatars the control plane keeps,
// cached on disk by their key.
//
// The key names the bytes (`owner-avatars/<owner>/<sha256>.png`), so a cached
// file is never wrong for its key; a new key only supersedes it. What is on
// disk draws at once, offline too. The service is asked once per launch per
// project, with the key held, and answers 304 when nothing changed. That ask
// is also what lets the service notice a week-old avatar and read it again.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineRecord } from "../auth/store";
import { appHomeDir } from "../paths";
import { fetchIcon } from "./client";
import { writeAtomic } from "./store";

type Cached = { type: string; data: string };

const dir = () => join(appHomeDir(), "icons");
const fileFor = (key: string) =>
  join(dir(), `${createHash("sha256").update(key).digest("hex")}.json`);

async function readCached(key: string): Promise<Cached | null> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(key), "utf8")) as Cached;
    return typeof parsed.type === "string" && typeof parsed.data === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const url = (icon: Cached) => `data:${icon.type};base64,${icon.data}`;

/** What this launch already answered, by workspace id. */
const answered = new Map<string, { key: string | null; url: string | null }>();
/** The ask per workspace in flight, so a list of tiles makes one request. */
const inFlight = new Map<string, Promise<string | null>>();

/** Ask the service, keep what is new, and return what to draw. */
async function ask(
  record: MachineRecord,
  workspaceId: string,
  held: string | null,
  heldUrl: string | null,
): Promise<string | null> {
  const answer = await fetchIcon(record, workspaceId, held).catch(() => null);
  // Unreachable: what is on disk stands, and the next launch asks again.
  if (!answer) return heldUrl;
  if (answer.kind === "same") {
    answered.set(workspaceId, { key: held, url: heldUrl });
    return heldUrl;
  }
  if (answer.kind === "none") {
    answered.set(workspaceId, { key: null, url: null });
    return null;
  }
  const icon = { type: answer.type, data: answer.bytes.toString("base64") };
  await writeAtomic(fileFor(answer.key), JSON.stringify(icon)).catch(() => {});
  answered.set(workspaceId, { key: answer.key, url: url(icon) });
  return url(icon);
}

/**
 * The icon to draw for a project, as a `data:` URL.
 *
 * @param iconKey What `/v1/sync/state` said the project's icon is.
 * @returns null for the letter tile.
 */
export async function workspaceIcon(
  record: MachineRecord,
  workspaceId: string,
  iconKey: string | null,
): Promise<string | null> {
  const known = answered.get(workspaceId);
  // Answered this launch, and the list names no newer icon than that answer.
  if (known && (!iconKey || iconKey === known.key)) return known.url;

  const cached = iconKey ? await readCached(iconKey) : null;
  if (cached) {
    // Drawn from disk now; the one ask of this launch runs behind it.
    if (!inFlight.has(workspaceId)) {
      const pending = ask(record, workspaceId, iconKey, url(cached)).finally(
        () => inFlight.delete(workspaceId),
      );
      inFlight.set(workspaceId, pending);
    }
    return url(cached);
  }

  const pending =
    inFlight.get(workspaceId) ??
    ask(record, workspaceId, null, null).finally(() =>
      inFlight.delete(workspaceId),
    );
  inFlight.set(workspaceId, pending);
  return pending;
}
