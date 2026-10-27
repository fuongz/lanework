// Orchestration in main (FE-87): the run engine, wired to the app.
//
// `main/index.ts` registers `orchestrationMain` for the page and starts the
// control server with `startControlServer`. Jev (W3) is handed in with
// `setJev`; without it every bounded question goes to the lead.
//
// The engine itself (`runtime.ts`) imports no Electron. This file gives it
// the app's folders, the chat's engines and the broadcast, and installs the
// engine tap so a lead's process gets its control env and a worker's its
// scratch.

import { join } from "node:path";
import { app } from "electron";
import {
  type JevMainHandlers,
  type OrchestrationMainHandlers,
  orchestrationChannels,
  type StartControlServer,
} from "../../../shared/orchestration";
import { sharedEngines } from "../conversation/engine";
import { broadcast } from "../ipc";
import { appHomeDir } from "../paths";
import { terminalFolder } from "../workspaces";
import { listenControl } from "./control-server";
import { setEngineTap } from "./engine-tap";
import { teamLeadOf } from "./leads";
import { Orchestrator } from "./runtime";

export { visibleText } from "./prompts";

let instance: Orchestrator | null = null;
let endpoint: string | null = null;
let jev: JevMainHandlers | null = null;

/** The control CLI the lead is told to run. */
export const controlCliPath = () =>
  join(appHomeDir(), "bin", "lanework-control");

function orchestrator(): Orchestrator {
  if (instance) return instance;
  const created = new Orchestrator({
    engines: () => sharedEngines(),
    folderOf: terminalFolder,
    dataDir: join(app.getPath("userData"), "orchestration"),
    broadcast: (event) => broadcast(orchestrationChannels.changed, event),
    cliPath: controlCliPath(),
    endpoint: () => endpoint,
    teamLead: teamLeadOf,
  });
  created.setJev(jev);
  setEngineTap({
    env: (target) => created.envFor(target),
    event: (event, folder) => created.onEvent(event, folder),
    write: (write) => created.onWrite(write),
    result: (result) => created.onResult(result),
  });
  instance = created;
  return created;
}

/** Hand in Jev's handlers; null: Jev is off and the lead decides. */
export function setJev(handlers: JevMainHandlers | null): void {
  jev = handlers;
  instance?.setJev(handlers);
}

/**
 * The folder a worker's conversation runs in, or null when it is not a
 * worker's. The chat reads a worker's transcript from there.
 */
export function workerFolderOf(
  workspace: string,
  conversation: string,
): string | null {
  return instance?.workerFolder(workspace, conversation) ?? null;
}

export const orchestrationMain: OrchestrationMainHandlers = {
  runs: (workspace) => orchestrator().runs(workspace),
  run: (workspace, runId) => orchestrator().run(workspace, runId),
  approve: (proposal) => orchestrator().approve(proposal),
  pause: (workspace, runId) => orchestrator().pause(workspace, runId),
  resume: (workspace, runId) => orchestrator().resume(workspace, runId),
  stop: (workspace, runId) => orchestrator().stop(workspace, runId),
  cancelTask: (workspace, runId, taskId) =>
    orchestrator().cancelTask(workspace, runId, taskId),
  approveScope: (workspace, runId, taskId) =>
    orchestrator().approveScope(workspace, runId, taskId),
  control: (runId, call, requestId) =>
    orchestrator().control(runId, call, requestId),
};

export const startControlServer: StartControlServer = async (control) => {
  const runs = orchestrator();
  const server = await listenControl({
    control,
    runOfToken: (token) => runs.runOfToken(token),
    listening: (address) => {
      endpoint = address;
    },
  });
  return {
    endpoint: server.endpoint,
    close: async () => {
      endpoint = null;
      await server.close();
    },
  };
};
