// The settings each conversation last ran with from chat, and the last ones
// used anywhere (FE-62/D9), as one JSON file under the app's userData.
// Nothing here imports Electron.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ComposerSettings,
  checkSettings,
  DEFAULT_SETTINGS,
  OPENCODE_MODEL_ID,
} from "../../../shared/conversation";
import { isAgentSessionId, isAgentSessionIdOf } from "../../../shared/terminal";

/** Conversations remembered, at most; the oldest go first. */
const KEEP = 500;

/**
 * Settings off the file, kept while their model may still be listed.
 *
 * NOTE: An OpenCode model is known only once its service has listed it
 * (FE-104), which may be after the file is read. One that is a
 * `provider/model` is kept as it was written, and checked again by
 * {@link checkSettings} each time it is handed out.
 */
function stored(value: unknown): ComposerSettings | null {
  const settings = checkSettings(value);
  if (settings) return settings;
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.model !== "string" || !OPENCODE_MODEL_ID.test(v.model))
    return null;
  const rest = checkSettings({ ...v, model: DEFAULT_SETTINGS.model });
  return rest ? { ...rest, model: v.model } : null;
}

/** What the settings file holds. */
interface Stored {
  last: ComposerSettings | null;
  /** By conversation id, least recently used first. */
  conversations: Record<string, ComposerSettings>;
}

/**
 * The composer settings remembered per conversation, kept in `file`.
 *
 * Writes are queued one after another; a failed write leaves the memory
 * copy answering this run.
 */
export function createSettingsStore(file: string) {
  let cache: Stored | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function load(): Promise<Stored> {
    if (cache) return cache;
    const empty: Stored = { last: null, conversations: {} };
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as Partial<Stored>;
      const conversations: Record<string, ComposerSettings> = {};
      for (const [id, settings] of Object.entries(value.conversations ?? {})) {
        const checked = stored(settings);
        if (
          (isAgentSessionId(id) || isAgentSessionIdOf("opencode", id)) &&
          checked
        )
          conversations[id] = checked;
      }
      cache = { last: stored(value.last), conversations };
    } catch {
      cache = empty;
    }
    return cache;
  }

  function persist(value: Stored): void {
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(value));
        await rename(temp, file);
      })
      .catch(() => {
        // The memory copy still answers this run.
      });
  }

  return {
    async of(id: string): Promise<ComposerSettings | null> {
      return checkSettings((await load()).conversations[id]);
    },
    async last(): Promise<ComposerSettings> {
      return checkSettings((await load()).last) ?? DEFAULT_SETTINGS;
    },
    async remember(id: string, settings: ComposerSettings): Promise<void> {
      const value = await load();
      const conversations = { ...value.conversations };
      delete conversations[id];
      conversations[id] = settings;
      const ids = Object.keys(conversations);
      for (const old of ids.slice(0, Math.max(0, ids.length - KEEP)))
        delete conversations[old];
      cache = { last: settings, conversations };
      persist(cache);
    },
    flushed: () => writing,
  };
}
