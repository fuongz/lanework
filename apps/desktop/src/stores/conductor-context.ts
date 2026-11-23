import type { ConductorMemory } from "#/../shared/conductor-sessions";
import type { ConnectorAgent } from "#/../shared/connectors";
import type { TeamLead } from "#/../shared/orchestration";
import { enabledConnectorNames } from "#/lib/connectors";

// A conductor's context files as they stand now (FE-96), for the prompt.
//
// Main says which paths are files, folders or gone; the gone ones are left
// out, so the conductor never goes looking for a file that is not there, and
// folders gain a trailing `/`. The saved conductor keeps every path: one that
// comes back is sent again.

/**
 * `lead` with only the context files still in `project`'s checkout. Without
 * a preload, or when main cannot answer, it is sent with none rather than not
 * at all.
 */
export async function withLiveContext(
  project: string,
  lead: TeamLead,
): Promise<TeamLead> {
  if (!lead.contextFiles.length) return lead;
  const surface = window.desktop?.leads;
  const entries = surface
    ? await surface.inspectContext(project, lead.contextFiles).catch(() => [])
    : [];
  return {
    ...lead,
    contextFiles: entries.flatMap((entry) =>
      entry.kind === "missing"
        ? []
        : [entry.kind === "folder" ? `${entry.path}/` : entry.path],
    ),
  };
}

/**
 * What `lead` remembers of `project` (FE-128), for a turn that carries its
 * rules. Null without a preload or when main cannot answer: the turn goes
 * without it rather than not at all.
 */
export async function conductorMemory(
  project: string,
  lead: TeamLead,
): Promise<ConductorMemory | null> {
  const surface = window.desktop?.leads;
  if (!surface) return null;
  return surface.memory(project, lead.id).catch(() => null);
}

/**
 * The connectors `lead` may use on `agent` in `project` besides Lanework's
 * own (FE-166), for a turn that carries its rules.
 *
 * Reads only the cached inventory, never a refresh: it runs on a send, which
 * must stay quick. Empty without a preload or when main cannot answer.
 */
export async function conductorConnectors(
  project: string,
  lead: TeamLead,
  agent: ConnectorAgent,
): Promise<string[]> {
  const surface = window.desktop?.connectors;
  if (!surface) return [];
  const inventory = await surface.inventory(project, agent).catch(() => null);
  return enabledConnectorNames(inventory, agent, lead);
}
