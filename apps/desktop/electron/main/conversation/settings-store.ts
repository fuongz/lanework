// The settings each conversation last ran with from chat, and the last ones
// used anywhere (FE-62/D9), as one JSON file under the app's userData.
// Nothing here imports Electron.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ComposerSettings,
  checkSettings,
  DEFAULT_SETTINGS,
} from "../../../shared/conversation";
import { isAgentSessionId } from "../../../shared/terminal";

/** Conversations remembered, at most; the oldest go first. */
const KEEP = 500;

interface Stored {
  last: ComposerSettings | null;
  /** By conversation id, oldest first. */
  conversations: Record<string, ComposerSettings>;
}

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
        const checked = checkSettings(settings);
        if (isAgentSessionId(id) && checked) conversations[id] = checked;
      }
      cache = { last: checkSettings(value.last), conversations };
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
      return (await load()).conversations[id] ?? null;
    },
    async last(): Promise<ComposerSettings> {
      return (await load()).last ?? DEFAULT_SETTINGS;
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
