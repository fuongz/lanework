// Codex's models as `codex` itself lists them: the `models` of its own
// cache, `~/.codex/models_cache.json`, which the CLI refreshes from the
// server. Only `visibility: "list"` ones, in Codex's priority order; an
// older generation than the newest is drawn under the divider.
//
// ⚠️ Read-only, and nothing here imports Electron. Ids are checked against
// `CODEX_MODEL_ID` before they may become `-m`'s value.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentModel,
  CODEX_MODEL_ID,
  CODEX_MODELS,
} from "../../../shared/conversation";

/** The most of the cache read: it carries every model's instructions. */
const CACHE_MAX = 8 * 1024 * 1024;

/** `gpt-6.1-sol` → 6; null when the id names no generation. */
function generation(id: string): number | null {
  const major = /(?:^|-)(\d+)(?:\.\d+)?(?:-|$)/.exec(id)?.[1];
  return major ? Number(major) : null;
}

/** The cache's listed models, or null when there is none to read. */
export function modelsOf(value: unknown): AgentModel[] | null {
  const list = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return null;
  const models = (list as Record<string, unknown>[])
    .filter(
      (entry) =>
        entry?.visibility === "list" &&
        typeof entry.slug === "string" &&
        CODEX_MODEL_ID.test(entry.slug),
    )
    .map((entry, at) => ({
      id: entry.slug as string,
      label:
        typeof entry.display_name === "string" && entry.display_name.trim()
          ? entry.display_name.trim().slice(0, 60)
          : (entry.slug as string),
      priority: typeof entry.priority === "number" ? entry.priority : 1000 + at,
    }))
    .sort((a, b) => a.priority - b.priority);
  if (models.length === 0) return null;
  const newest = Math.max(...models.map((entry) => generation(entry.id) ?? 0));
  return models.map(({ id, label }) => {
    const major = generation(id);
    return {
      id,
      label,
      agent: "codex" as const,
      ...(major !== null && major < newest ? { legacy: true } : {}),
    };
  });
}

/** One cache read per change of the file. */
export function createCodexModels(home: () => string) {
  let cached: { file: string; mtime: number; models: AgentModel[] } | null =
    null;
  return async function codexModels(): Promise<AgentModel[]> {
    const file = join(home(), ".codex", "models_cache.json");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > CACHE_MAX) return [...CODEX_MODELS];
    if (cached?.file === file && cached.mtime === info.mtimeMs)
      return cached.models;
    let models: AgentModel[] | null = null;
    try {
      models = modelsOf(JSON.parse(await readFile(file, "utf8")));
    } catch {
      models = null;
    }
    const out = models ?? [...CODEX_MODELS];
    cached = { file, mtime: info.mtimeMs, models: out };
    return out;
  };
}
