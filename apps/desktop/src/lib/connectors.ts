// Connectors as a conductor sees them (FE-166): the inventory grouped by where
// each one comes from, which a conductor's agent can use, and the names its
// prompt lists.

import {
  CONNECTOR_SOURCES,
  type Connector,
  type ConnectorAgent,
  type ConnectorInventory,
  type ConnectorSource,
} from "#/../shared/connectors";
import { AGENT_LABELS } from "#/../shared/conversation";
import type { TeamLead } from "#/../shared/orchestration";

export const CONNECTOR_SOURCE_LABELS: Record<ConnectorSource, string> = {
  user: "Your config",
  project: "This project",
  local: "Local to you",
  plugin: "Plugins",
  "claude-ai": "Claude.ai account",
};

/** The most names the conductor's prompt lists. */
export const CONNECTORS_PROMPT_MAX = 30;

/** How one connector stands for a conductor on `agent`. */
export type ConnectorState =
  /** The agent cannot use it; `reason` says why. */
  { kind: "unavailable"; reason: string } | { kind: "on" } | { kind: "off" };

export interface ConnectorRow {
  connector: Connector;
  state: ConnectorState;
}

export interface ConnectorGroup {
  source: ConnectorSource;
  label: string;
  rows: ConnectorRow[];
}

/** Why `agent` cannot use `connector`, or null when it can. */
export function unavailableReason(
  connector: Connector,
  agent: ConnectorAgent,
): string | null {
  if (connector.agent === agent) return null;
  return `It is set up for ${AGENT_LABELS[connector.agent]}; this conductor runs on ${AGENT_LABELS[agent]}.`;
}

/**
 * The inventory as groups, one per source that has any connector, in the
 * order of {@link CONNECTOR_SOURCES}; each group's rows by name.
 *
 * Lanework's own servers are left out: they are always on and no switch
 * could change them.
 */
export function connectorGroups(
  inventory: ConnectorInventory,
  agent: ConnectorAgent,
  disabled: ReadonlySet<string>,
): ConnectorGroup[] {
  return CONNECTOR_SOURCES.flatMap((source) => {
    const rows = inventory.connectors
      .filter((connector) => connector.source === source && !connector.lanework)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((connector): ConnectorRow => {
        const reason = unavailableReason(connector, agent);
        const state: ConnectorState = reason
          ? { kind: "unavailable", reason }
          : disabled.has(connector.name)
            ? { kind: "off" }
            : { kind: "on" };
        return { connector, state };
      });
    return rows.length
      ? [{ source, label: CONNECTOR_SOURCE_LABELS[source], rows }]
      : [];
  });
}

/**
 * The names a conductor on `agent` may be told it can use: every connector
 * of that agent that is not Lanework's own, not switched off for it and not
 * waiting on a sign-in. Sorted and without repeats, so the line never changes
 * between two reads of the same inventory.
 */
export function enabledConnectorNames(
  inventory: ConnectorInventory | null,
  agent: ConnectorAgent,
  lead: Pick<TeamLead, "connectors">,
): string[] {
  if (!inventory) return [];
  const disabled = new Set(lead.connectors?.disabled ?? []);
  const names = new Set<string>();
  for (const connector of inventory.connectors) {
    if (connector.lanework || connector.agent !== agent) continue;
    if (connector.auth === "needs-auth" || disabled.has(connector.name))
      continue;
    names.add(connector.name);
  }
  return [...names].sort().slice(0, CONNECTORS_PROMPT_MAX);
}

/** `disabled` with `name` switched on or off; empty means none disabled. */
export function withConnector(
  disabled: readonly string[],
  name: string,
  enabled: boolean,
): { disabled: string[] } | undefined {
  const next = enabled
    ? disabled.filter((entry) => entry !== name)
    : disabled.includes(name)
      ? [...disabled]
      : [...disabled, name];
  return next.length ? { disabled: next } : undefined;
}

/**
 * `disabled` with every one of `names` switched on or off at once: a group's
 * switch, or Disable all / Enable all.
 */
export function withConnectors(
  disabled: readonly string[],
  names: readonly string[],
  enabled: boolean,
): { disabled: string[] } | undefined {
  const touched = new Set(names);
  const rest = disabled.filter((entry) => !touched.has(entry));
  const next = enabled ? rest : [...rest, ...touched];
  return next.length ? { disabled: next } : undefined;
}

/** The rows a switch can change: those the agent can use. */
export function switchable(rows: readonly ConnectorRow[]): ConnectorRow[] {
  return rows.filter(
    (row) => row.state.kind === "on" || row.state.kind === "off",
  );
}
