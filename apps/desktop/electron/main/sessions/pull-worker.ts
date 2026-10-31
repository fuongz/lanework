// The Pull's worker thread (FE-112): `runPullJob` off main's thread, talking
// to main over `parentPort`. Bundled beside main as `session-pull.cjs`
// (`scripts/electron-bundle.mjs`), and started by `pull.ts`.
//
// NOTE: No Electron and no store here. A worker thread of the main process
// cannot load Electron's modules, and the store's connection is main's: the
// worker reads the CLIs' files, main writes what it read.
import { constants, setPriority } from "node:os";
import { parentPort, workerData } from "node:worker_threads";
import type { IngestState } from "../../session-store/types";
import {
  type MainMessage,
  type PullJob,
  runPullJob,
  type WorkerMessage,
} from "./pull-job";

const port = parentPort;
if (!port) throw new Error("The Pull runs in a worker thread only.");

// NOTE: On Linux a nice value is a thread's own, and `setPriority` without a
// pid sets the calling thread's: this worker's alone. On macOS and Windows it
// is the whole process's, main and every window with it, so it is left
// alone there, and the pauses between files (`pull-job.ts`) do that work.
if (process.platform === "linux") {
  try {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed here: the pauses still hold.
  }
}

const post = (message: WorkerMessage) => port.postMessage(message);

let asked = 0;
const waiting = new Map<
  number,
  (states: Record<string, IngestState | null>) => void
>();

port.on("message", (message: MainMessage) => {
  if (message?.t !== "states") return;
  const answer = waiting.get(message.req);
  waiting.delete(message.req);
  answer?.(message.states);
});

runPullJob(workerData as PullJob, {
  states: (keys) =>
    new Promise((resolve) => {
      asked += 1;
      waiting.set(asked, resolve);
      post({ t: "states", req: asked, keys });
    }),
  write: (batch) => post({ t: "write", batch }),
  progress: (step) => post({ t: "progress", step }),
}).then(
  () => post({ t: "done" }),
  (error: unknown) =>
    post({
      t: "failed",
      message: error instanceof Error ? error.message : String(error),
    }),
);
