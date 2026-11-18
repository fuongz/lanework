// `models.list` (FE-156): the catalog a proposal's tasks may name, asked for
// when a lead is about to name a model instead of riding in every
// conductor turn.
//
// Kept short for an agent's context: ids only (labels and JSON keys add
// nothing a model needs), one comma-separated string per agent, and
// OpenCode's ids grouped by provider with the provider said once.
//
// Pure: main hands in the catalog, the conductor's workers and its runs.

import {
  type ConductorRunEntry,
  type ModelsListing,
  RUN_TASK_OUTCOMES,
  type SessionInputs,
} from "../../../shared/conductor-sessions";
import type { AgentModel } from "../../../shared/conversation";
import type { TeamLead } from "../../../shared/orchestration";
import type { TerminalAgent } from "../../../shared/terminal";

/** The outcomes worth saying: interrupted and unreviewed say nothing. */
const TOLD = ["accepted", "failed", "blocked", "cancelled"] as const;

/**
 * How each model fared across `runs`, newest first: `model` → `"accepted 5,
 * failed 1"`, zeros left out. Null when no task counted.
 */
export function runHistory(
  runs: readonly ConductorRunEntry[],
): Record<string, string> | null {
  const tally = new Map<string, Record<string, number>>();
  for (const run of runs)
    for (const task of run.tasks) {
      const counts =
        tally.get(task.model) ??
        Object.fromEntries(RUN_TASK_OUTCOMES.map((outcome) => [outcome, 0]));
      counts[task.outcome] = (counts[task.outcome] ?? 0) + 1;
      tally.set(task.model, counts);
    }
  const out: Record<string, string> = {};
  for (const [model, counts] of tally) {
    const said = TOLD.filter((outcome) => (counts[outcome] ?? 0) > 0).map(
      (outcome) => `${outcome} ${counts[outcome]}`,
    );
    if (said.length) out[model] = said.join(", ");
  }
  return Object.keys(out).length ? out : null;
}

/** `ids` as one string, or OpenCode's as `{ provider: "model, model" }`. */
function group(
  agent: TerminalAgent,
  ids: readonly string[],
): string | Record<string, string> {
  if (agent !== "opencode") return ids.join(", ");
  const byProvider = new Map<string, string[]>();
  for (const id of ids) {
    const cut = id.indexOf("/");
    const provider = cut === -1 ? "" : id.slice(0, cut);
    const model = cut === -1 ? id : id.slice(cut + 1);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return Object.fromEntries(
    [...byProvider].map(([provider, models]) => [provider, models.join(", ")]),
  );
}

/**
 * The listing for one caller.
 *
 * A conductor with workers of its own may name those only, so it gets those,
 * each with its tier (`claude-opus-5-5 [heavy]`); every other caller gets the
 * catalog, legacy models left out.
 */
export function modelsListing(options: {
  input: SessionInputs["models.list"];
  catalog: readonly AgentModel[];
  lead: TeamLead | null;
  runs: readonly ConductorRunEntry[];
}): ModelsListing {
  const { input, lead } = options;
  const own = !!lead?.workers.length;
  const entries: { agent: TerminalAgent; id: string; shown: string }[] = own
    ? (lead?.workers ?? []).map((worker) => ({
        agent: worker.agent,
        id: worker.model,
        shown: worker.tier ? `${worker.model} [${worker.tier}]` : worker.model,
      }))
    : options.catalog
        .filter((entry) => !entry.legacy)
        .map((entry) => ({
          agent: entry.agent,
          id: entry.id,
          shown: entry.id,
        }));
  const query = input.query?.toLowerCase();
  const picked = entries.filter(
    (entry) =>
      (!input.agent || entry.agent === input.agent) &&
      (!query || entry.id.toLowerCase().includes(query)),
  );
  const models: ModelsListing["models"] = {};
  for (const agent of ["claude", "codex", "opencode"] as const) {
    const ids = picked
      .filter((entry) => entry.agent === agent)
      .map((entry) => entry.shown);
    if (ids.length) models[agent] = group(agent, ids);
  }
  const listing: ModelsListing = {
    source: own ? "conductor" : "catalog",
    models,
    tiers: !own || !!lead?.workers.some((worker) => worker.tier !== null),
  };
  const history = runHistory(options.runs);
  if (history) listing.history = history;
  return listing;
}
