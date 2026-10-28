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
import { listenControl, type SessionsControl } from "./control-server";
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
  // Saved runs are read now, not on the page's first call: until then a
  // worker's conversation would pass for an ordinary one (FE-90/D8).
  void created
    .load()
    .catch((error: unknown) =>
      console.error("Unable to read orchestration runs", error),
    );
  return created;
}

/** Hand in Jev's handlers; null: Jev is off and the lead decides. */
export function setJev(handlers: JevMainHandlers | null): void {
  jev = handlers;
  instance?.setJev(handlers);
}

/**
 * The folder a worker's conversation runs in, or null when it is not a
 * worker's. The chat reads a worker's transcript from there, and refuses to
 * send to one directly.
 */
export function workerFolderOf(
  workspace: string,
  conversation: string,
): string | null {
  return orchestrator().workerFolder(workspace, conversation);
}

/** Whether an engine in `folder` runs a worker of a run: its own worktree. */
export function isWorkerFolder(folder: string): boolean {
  return orchestrator().isWorkerFolder(folder);
}

/** The control server's `127.0.0.1:<port>`, once it listens. */
export function controlEndpoint(): string | null {
  return endpoint;
}

/**
 * Whether `conversation` is an orchestration worker's: its asks go to its
 * lead, never to the person (FE-100/O1).
 */
export function isWorkerConversation(
  workspace: string,
  conversation: string,
): boolean {
  return orchestrator().workerFolder(workspace, conversation) !== null;
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
  leftovers: (workspace, runId) => orchestrator().leftovers(workspace, runId),
  cleanUp: (workspace, runId) => orchestrator().cleanUp(workspace, runId),
  control: (runId, call, requestId) =>
    orchestrator().control(runId, call, requestId),
};

/**
 * Listen for the lead's CLI, and a conductor's `sessions.*` calls when
 * `sessions` is given.
 */
export const startControlServer = async (
  control: Parameters<StartControlServer>[0],
  sessions?: SessionsControl,
): ReturnType<StartControlServer> => {
  const runs = orchestrator();
  const server = await listenControl({
    control,
    sessions,
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
