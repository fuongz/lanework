// Each agent's connectors in one project (FE-166): what `agent-setup/read.ts`
// finds in the config files, plus the claude.ai account's connectors for
// Claude (`account.ts`).
//
// NOTE: Performance. Nothing runs at app start, on a spawn or on a timer, and
// nothing watches a file. A project's files are read on its first
// `connectorInventory()` and memoized until `refreshConnectors()` or
// `forgetConnectors()`. Only `refreshConnectors(…, "claude")` starts a process
// (`claude mcp list`); for Codex and OpenCode a refresh just reads the files
// again. The flags each process gets are in `flags.ts`.
//
// Nothing here imports Electron.

import type { SetupMcpServer } from "../../../shared/agent-setup";
import type {
  Connector,
  ConnectorAgent,
  ConnectorInventory,
  ConnectorSource,
} from "../../../shared/connectors";
import type { AgentHome } from "../agent-home";
import { readAgentSetup, readClaudeAiHint } from "../agent-setup/read";
import { type AccountScan, accountScan, refreshAccount } from "./account";
import { isLaneworkConnector } from "./flags";

type FileScan = {
  scannedAt: string;
  byAgent: Record<ConnectorAgent, Connector[]>;
  /** `claudeAiMcpEverConnected`: the claude.ai fallback before any scan. */
  claudeAiHint: string[];
};

/** Per project folder; dropped by a refresh. */
const files = new Map<string, Promise<FileScan>>();

const SOURCE: Record<SetupMcpServer["scope"], ConnectorSource> = {
  user: "user",
  project: "project",
  local: "local",
  plugin: "plugin",
  system: "user",
};

function transportOf(
  transport: SetupMcpServer["transport"],
): Connector["transport"] {
  return transport === "stdio" || transport === "http" || transport === "sse"
    ? transport
    : undefined;
}

/**
 * The name an agent knows a server by. A Claude plugin's server is
 * `plugin:<plugin>:<server>`, the plugin named without its `@marketplace`.
 */
function nameOf(server: SetupMcpServer): string {
  if (server.agent !== "claude" || server.scope !== "plugin" || !server.plugin)
    return server.name;
  const plugin = server.plugin.split("@")[0] || server.plugin;
  return `plugin:${plugin}:${server.name}`;
}

/** The servers in effect, the nearest scope first, one row per name. */
function fromSetup(mcp: SetupMcpServer[]): FileScan["byAgent"] {
  const byAgent: FileScan["byAgent"] = { claude: [], codex: [], opencode: [] };
  const seen = new Set<string>();
  for (const server of mcp) {
    // Off in its own config, or shadowed by a nearer one: not reachable.
    if (server.disabled) continue;
    const name = nameOf(server);
    const key = `${server.agent}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const transport = transportOf(server.transport);
    byAgent[server.agent].push({
      name,
      agent: server.agent,
      source: SOURCE[server.scope],
      ...(transport ? { transport } : {}),
      lanework: isLaneworkConnector(name),
    });
  }
  return byAgent;
}

function readFiles(folder: string, where: AgentHome): Promise<FileScan> {
  let pending = files.get(folder);
  if (!pending) {
    pending = (async () => {
      const [{ setup }, claudeAiHint] = await Promise.all([
        readAgentSetup(folder, where),
        readClaudeAiHint(where),
      ]);
      return {
        scannedAt: setup.readAt,
        byAgent: fromSetup(setup.mcp),
        claudeAiHint,
      };
    })();
    // A failed read is not kept: the next ask reads again.
    const mine = pending;
    mine.catch(() => {
      if (files.get(folder) === mine) files.delete(folder);
    });
    files.set(folder, mine);
  }
  return pending;
}

/** The claude.ai rows: the last scan's, else the hint with unknown auth. */
function accountRows(account: AccountScan | null, hint: string[]): Connector[] {
  const list =
    account?.connectors ??
    hint.map((name) => ({ name, auth: "unknown" as const }));
  return list.map(({ name, auth }) => ({
    name,
    agent: "claude",
    source: "claude-ai",
    transport: "http",
    auth,
    lanework: isLaneworkConnector(name),
  }));
}

async function build(
  folder: string,
  agent: ConnectorAgent,
  where: AgentHome,
  error?: string,
): Promise<ConnectorInventory> {
  const scan = await readFiles(folder, where);
  const connectors = [...scan.byAgent[agent]];
  let accountScannedAt: string | undefined;
  if (agent === "claude") {
    const account = await accountScan();
    accountScannedAt = account?.scannedAt;
    const have = new Set(connectors.map((entry) => entry.name));
    for (const row of accountRows(account, scan.claudeAiHint))
      if (!have.has(row.name)) connectors.push(row);
  }
  return {
    agent,
    connectors,
    scannedAt: scan.scannedAt,
    ...(accountScannedAt ? { accountScannedAt } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * `agent`'s connectors in `folder`: the memoized file scan, plus for Claude
 * the last account scan (or the `~/.claude.json` hint before the first one).
 * Cheap after the first call per project; never starts a process.
 */
export async function connectorInventory(
  folder: string,
  agent: ConnectorAgent,
  where: AgentHome,
): Promise<ConnectorInventory> {
  try {
    return await build(folder, agent, where);
  } catch (cause) {
    return {
      agent,
      connectors: [],
      scannedAt: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Read `folder`'s files again and, for Claude, run the account scan (single
 * flight, 20 s at most). A failed scan keeps the last one and says why in
 * `error`.
 */
export async function refreshConnectors(
  folder: string,
  agent: ConnectorAgent,
  where: AgentHome,
): Promise<ConnectorInventory> {
  files.delete(folder);
  let error: string | undefined;
  if (agent === "claude")
    await refreshAccount().catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  try {
    return await build(folder, agent, where, error);
  } catch (cause) {
    return {
      agent,
      connectors: [],
      scannedAt: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Drop the memoized file scan: one folder's, or every one. */
export function forgetConnectors(folder?: string): void {
  if (folder === undefined) files.clear();
  else files.delete(folder);
}
