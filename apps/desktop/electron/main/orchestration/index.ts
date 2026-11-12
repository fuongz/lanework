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
import type {
  ConductorRunEntry,
  ConductorRunTask,
  RunTaskOutcome,
} from "../../../shared/conductor-sessions";
import {
  type JevMainHandlers,
  type OrchestrationMainHandlers,
  type OrchestrationRun,
  type OrchestrationTask,
  orchestrationChannels,
  type StartControlServer,
} from "../../../shared/orchestration";
import { conductorMemory } from "../conversation";
import { sharedEngines } from "../conversation/engine";
import { broadcast } from "../ipc";
import { appHomeDir } from "../paths";
import { terminalFolder } from "../projects";
import { listenControl, type SessionsControl } from "./control-server";
import { setEngineTap } from "./engine-tap";
import { teamLeadOf } from "./leads";
import { RunOwnership } from "./owner";
import { Orchestrator } from "./runtime";

export { visibleText } from "./prompts";

/** How a task ended, as a conductor's memory words it (FE-131). */
function outcomeOf(task: OrchestrationTask): RunTaskOutcome {
  if (task.accepted) return "accepted";
  switch (task.status) {
    case "cancelled":
    case "cancelling":
      return "cancelled";
    case "failed":
    case "blocked":
    case "interrupted":
      return task.status;
    default:
      // Completed but never reviewed, or never started.
      return "unreviewed";
  }
}

/** What a conductor remembers of a run that ended. */
export function runMemoryEntry(
  run: OrchestrationRun,
  title: string,
): ConductorRunEntry {
  return {
    runId: run.id,
    title,
    status: run.status === "finished" ? "finished" : "stopped",
    createdAt: run.createdAt,
    endedAt: Date.now(),
    tasks: run.tasks.map((task): ConductorRunTask => {
      const out: ConductorRunTask = {
        title: task.title,
        agent: task.agent,
        model: task.model,
        tier: task.tier,
        effort: task.effort,
        outcome: outcomeOf(task),
      };
      if (task.error) out.error = task.error;
      return out;
    }),
  };
}

let instance: Orchestrator | null = null;
let endpoint: string | null = null;
let jev: JevMainHandlers | null = null;

/** The control CLI the lead is told to run. */
export const controlCliPath = () =>
  join(appHomeDir(), "bin", "lanework-control");

function orchestrator(): Orchestrator {
  if (instance) return instance;
  const dataDir = join(app.getPath("userData"), "orchestration");
  // The installed app and a dev build share this folder: one drives the
  // runs, the other follows them read-only (FE-138).
  const ownership = new RunOwnership(
    join(dataDir, "owner.json"),
    app.isPackaged ? "Lanework (Applications)" : "Lanework dev",
    () => instance?.takeOver(),
  );
  app.on("will-quit", () => ownership.release());
  const created = new Orchestrator({
    ownership,
    engines: () => sharedEngines(),
    folderOf: terminalFolder,
    dataDir,
    broadcast: (event) => broadcast(orchestrationChannels.changed, event),
    cliPath: controlCliPath(),
    endpoint: () => endpoint,
    teamLead: teamLeadOf,
    // A run without a team lead has no memory to write to (FE-131/D3).
    runEnded: (run, title) =>
      run.teamLead
        ? conductorMemory.recordRun(
            run.project,
            run.teamLead,
            runMemoryEntry(run, title),
          )
        : undefined,
  });
  created.setJev(jev);
  setEngineTap({
    env: (target) => created.envFor(target),
    event: (event, folder) => created.onEvent(event, folder),
    write: (write) => created.onWrite(write),
    result: (result) => created.onResult(result),
    guard: (target) => created.guardsLead(target),
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
  project: string,
  conversation: string,
): string | null {
  return orchestrator().workerFolder(project, conversation);
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
  project: string,
  conversation: string,
): boolean {
  return orchestrator().workerFolder(project, conversation) !== null;
}

/**
 * What main offers the page. `markReportSeen` (FE-136/D4) is main's own
 * until the shared handler type names it: the notification IPC calls it.
 */
export const orchestrationMain: OrchestrationMainHandlers & {
  /** The user opened a finished or stopped run: its report is seen. */
  markReportSeen: (runId: string) => Promise<void>;
} = {
  runs: (project) => orchestrator().runs(project),
  run: (project, runId) => orchestrator().run(project, runId),
  approve: (proposal) => orchestrator().approve(proposal),
  pause: (project, runId) => orchestrator().pause(project, runId),
  resume: (project, runId) => orchestrator().resume(project, runId),
  stop: (project, runId) => orchestrator().stop(project, runId),
  cancelTask: (project, runId, taskId) =>
    orchestrator().cancelTask(project, runId, taskId),
  approveScope: (project, runId, taskId) =>
    orchestrator().approveScope(project, runId, taskId),
  leftovers: (project, runId) => orchestrator().leftovers(project, runId),
  cleanUp: (project, runId) => orchestrator().cleanUp(project, runId),
  control: (runId, call, requestId) =>
    orchestrator().control(runId, call, requestId),
  markReportSeen: (runId) => orchestrator().markReportSeen(runId),
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
