// Connectors (FE-166): the MCP servers an agent can reach from a project,
// and where each one comes from.
//
// Contracts and constants only: no I/O, no Node or Electron.

export const CONNECTOR_AGENTS = ["claude", "codex", "opencode"] as const;
export type ConnectorAgent = (typeof CONNECTOR_AGENTS)[number];

export const CONNECTOR_SOURCES = [
  "user",
  "project",
  "local",
  "plugin",
  "claude-ai",
] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

export type Connector = {
  name: string;
  agent: ConnectorAgent;
  source: ConnectorSource;
  transport?: "stdio" | "http" | "sse";
  auth?: "ok" | "needs-auth" | "unknown";
  /** This is Lanework's own server. */
  lanework: boolean;
};

export type ConnectorInventory = {
  agent: ConnectorAgent;
  connectors: Connector[];
  /** ISO 8601: when the config files were last read. */
  scannedAt: string;
  /** ISO 8601: when the account scan last ran; absent if it never did. */
  accountScannedAt?: string;
  error?: string;
};

// ─── IPC ────────────────────────────────────────────────────────────────────

export const connectorsChannels = {
  /** The cached inventory; cheap. */
  inventory: "connectors:inventory",
  /** Run the expensive account scan, then return the new inventory. */
  refresh: "connectors:refresh",
} as const;

/** The slice of `window.desktop` that reaches connectors. */
export interface DesktopConnectorsApi {
  inventory: (
    project: string,
    agent: ConnectorAgent,
  ) => Promise<ConnectorInventory>;
  refresh: (
    project: string,
    agent: ConnectorAgent,
  ) => Promise<ConnectorInventory>;
}
