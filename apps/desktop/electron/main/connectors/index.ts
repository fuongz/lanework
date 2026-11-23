// Connectors (FE-166) over IPC: `connectors:inventory` and
// `connectors:refresh`. `main/index.ts` calls `registerConnectors(devUrl)`.
//
// NOTE: The renderer names a project by slug; its folder is resolved here
// from the folder links main wrote down (as Settings › Projects does), so no
// renderer can point a read at a folder of its choosing. Registering reads
// nothing: every scan waits for the first ask (`inventory.ts`).
import {
  CONNECTOR_AGENTS,
  type ConnectorAgent,
  type ConnectorInventory,
  connectorsChannels,
} from "../../../shared/connectors";
import { agentHome } from "../agent-home";
import { handle } from "../ipc";
import { terminalFolder } from "../projects/session";
import { agentHomeDir } from "../test-seams";
import { connectorInventory, refreshConnectors } from "./inventory";

function argsOf(args: unknown[]): { project: string; agent: ConnectorAgent } {
  const [project, agent] = args;
  if (typeof project !== "string" || !project || project.length > 200)
    throw new Error("Pick a project first.");
  if (!CONNECTOR_AGENTS.includes(agent as ConnectorAgent))
    throw new Error("Unknown agent.");
  return { project, agent: agent as ConnectorAgent };
}

async function folderOf(project: string): Promise<string> {
  const folder = await terminalFolder(project);
  if (!folder) throw new Error("This project has no folder on this machine.");
  return folder;
}

export function registerConnectors(devUrl: string | undefined): void {
  handle(
    connectorsChannels.inventory,
    devUrl,
    async (args): Promise<ConnectorInventory> => {
      const { project, agent } = argsOf(args);
      return connectorInventory(
        await folderOf(project),
        agent,
        agentHome(agentHomeDir()),
      );
    },
  );
  handle(
    connectorsChannels.refresh,
    devUrl,
    async (args): Promise<ConnectorInventory> => {
      const { project, agent } = argsOf(args);
      return refreshConnectors(
        await folderOf(project),
        agent,
        agentHome(agentHomeDir()),
      );
    },
  );
}
