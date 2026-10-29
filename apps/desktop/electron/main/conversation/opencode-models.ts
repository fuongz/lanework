// OpenCode's models and agents as its service lists them (FE-104):
// `GET /api/model` for the models of every provider the user set up,
// `/api/provider` for the providers' names, `/api/model/default` for the one
// OpenCode itself starts on, and `/api/agent` for the agents a conversation
// may run as.
//
// A model is `provider/model` here, the id OpenCode's own picker uses. Its
// variants (OpenCode's reasoning efforts) are kept beside the list: the
// composer's effort picks one when a turn starts (`opencodeVariant`).
//
// Ported from Monocode's `catalog` (`provider/opencode.rs`). Nothing here
// imports Electron.
import {
  type AgentModel,
  type Effort,
  OPENCODE_MODEL_ID,
} from "../../../shared/conversation";
import type { OpenCodeClient } from "./opencode-client";

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const list = (value: unknown): Json[] =>
  Array.isArray(value) ? (value as unknown[]).map(record) : [];

/** Agents OpenCode runs for itself, never one a conversation is given. */
const HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

/** OpenCode's variant names, weakest first, as Monocode orders them. */
const VARIANT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "max",
  "ultra",
];

/** Where each composer effort sits in {@link VARIANT_ORDER}. */
const EFFORT_RANK: Record<Effort, number> = {
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 7,
};

/** Each listed model's variants, by `provider/model` id. */
const variants = new Map<string, string[]>();
/** The primary agents, `build` first when OpenCode has it. */
let agents: string[] = [];

/**
 * The variant of model `id` that `effort` asks for, or null for a model that
 * has none (it runs on its own default).
 *
 * The one of that name, else the strongest weaker one, else the weakest
 * stronger one.
 */
export function opencodeVariant(id: string, effort: Effort): string | null {
  const own = variants.get(id);
  if (!own?.length) return null;
  if (own.includes(effort)) return effort;
  const want = EFFORT_RANK[effort];
  const rank = (name: string) => {
    const at = VARIANT_ORDER.indexOf(name.toLowerCase());
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  const ranked = [...own].sort((a, b) => rank(a) - rank(b));
  const weaker = ranked.filter((name) => rank(name) <= want).at(-1);
  return (
    weaker ??
    ranked.find((name) => rank(name) !== Number.POSITIVE_INFINITY) ??
    null
  );
}

/** The agent a new conversation runs as: `build`, else the first primary. */
export function opencodeAgent(): string {
  return agents[0] ?? "build";
}

/** `provider/model` split back: OpenCode's own `{ providerID, id }`. */
export function modelRef(id: string): { providerID: string; id: string } {
  const at = id.indexOf("/");
  return { providerID: id.slice(0, at), id: id.slice(at + 1) };
}

/**
 * A model's `provider/model` id. OpenCode's own `id` may carry its provider
 * already (`opencode/gpt-6-sol`), or a path of the gateway's
 * (`openai/gpt-6.1-terra` under `cloudflare-ai-gateway`).
 */
function idOf(provider: string | null, raw: string | null): string | null {
  if (!provider || !raw) return null;
  return raw.startsWith(`${provider}/`) ? raw : `${provider}/${raw}`;
}

/** The primary, visible agents in `/api/agent`'s answer, `build` first. */
function agentsOf(value: unknown): string[] {
  const out = list(value).flatMap((agent) => {
    const id = str(agent.id) ?? str(agent.name);
    const mode = str(agent.mode);
    const primary = !mode || mode === "primary" || mode === "all";
    return id && primary && agent.hidden !== true && !HIDDEN_AGENTS.has(id)
      ? [id]
      : [];
  });
  return out.includes("build")
    ? ["build", ...out.filter((id) => id !== "build")]
    : out;
}

/** A model row's variant names, weakest first. */
function variantsOf(row: Json): string[] {
  const raw = row.variants;
  const names = Array.isArray(raw)
    ? list(raw).flatMap((entry) =>
        str(entry.id) ? [str(entry.id) as string] : [],
      )
    : Object.keys(record(raw));
  const rank = (name: string) => {
    const at = VARIANT_ORDER.indexOf(name.toLowerCase());
    return at < 0 ? VARIANT_ORDER.length : at;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b));
}

/** OpenCode Go's provider id: its group leads for a subscriber (FE-104). */
const GO_PROVIDER = "opencode-go";

/**
 * OpenCode's models, as the picker offers them, from its service.
 *
 * Grouped by provider, as the picker lists them: OpenCode Go's first when
 * the user has a Go key (`goFirst`), the rest by name; within a provider by
 * name, its deprecated ones last. The one OpenCode starts on is `preferred`.
 * A disabled one, or one that is not a chat model, is left out.
 *
 * NOTE: Every id is checked against `OPENCODE_MODEL_ID` before it may reach
 * a request: the list is the service's, and the composer sends it back.
 */
export async function readOpenCodeModels(
  client: OpenCodeClient,
  goFirst = false,
): Promise<AgentModel[]> {
  const [models, providers, fallback, agentList] = await Promise.all([
    client.request("GET", "/api/model"),
    client.request("GET", "/api/provider").catch(() => []),
    client.request("GET", "/api/model/default").catch(() => null),
    client.request("GET", "/api/agent").catch(() => []),
  ]);
  const names = new Map<string, string>();
  for (const provider of list(providers)) {
    const id = str(provider.id);
    if (id) names.set(id, str(provider.name) ?? id);
  }
  const seen = new Set<string>();
  const out: AgentModel[] = [];
  const nextVariants = new Map<string, string[]>();
  for (const row of list(models)) {
    const provider = str(row.providerID);
    if (row.enabled === false) continue;
    if (row.type !== undefined && row.type !== "chat") continue;
    const id = idOf(provider, str(row.id) ?? str(row.modelID));
    if (!provider || !id || !OPENCODE_MODEL_ID.test(id) || seen.has(id))
      continue;
    const model = id.slice(provider.length + 1);
    seen.add(id);
    const name = (str(row.name) ?? model).slice(0, 60);
    out.push({
      id,
      label: name,
      agent: "opencode",
      group: (names.get(provider) ?? provider).slice(0, 40),
      ...(row.status === "deprecated" ? { legacy: true } : {}),
    });
    nextVariants.set(id, variantsOf(row));
  }
  const first = record(fallback);
  const preferred = idOf(str(first.providerID), str(first.id));
  for (const entry of out) if (entry.id === preferred) entry.preferred = true;
  const go = (entry: AgentModel) =>
    goFirst && entry.id.startsWith(`${GO_PROVIDER}/`) ? 0 : 1;
  out.sort(
    (a, b) =>
      go(a) - go(b) ||
      (a.group ?? "").localeCompare(b.group ?? "") ||
      Number(a.legacy ?? false) - Number(b.legacy ?? false) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  variants.clear();
  for (const [id, names] of nextVariants) variants.set(id, names);
  agents = agentsOf(agentList);
  return out;
}

/**
 * OpenCode's model list, asked of its service at most once a `maxAgeMs`.
 *
 * @param connect A client for the machine's lists, or a throw when OpenCode
 *   is missing, too old or its service cannot start.
 * @returns An empty list when it cannot be read: no OpenCode model is then
 *   offered.
 */
export function createOpenCodeModels(
  connect: () => Promise<OpenCodeClient>,
  hasGo: () => Promise<boolean> = async () => false,
  maxAgeMs = 30_000,
) {
  let cached: { at: number; models: AgentModel[] } | null = null;
  let running: Promise<AgentModel[]> | null = null;
  return async function opencodeModels(fresh = false): Promise<AgentModel[]> {
    if (!fresh && cached && Date.now() - cached.at < maxAgeMs)
      return cached.models;
    running ??= Promise.all([connect(), hasGo().catch(() => false)])
      .then(([client, go]) => readOpenCodeModels(client, go))
      // A failed read keeps what the last one found.
      .catch(() => cached?.models ?? [])
      .then((models) => {
        cached = { at: Date.now(), models };
        return models;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}
