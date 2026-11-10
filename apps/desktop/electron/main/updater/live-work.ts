// INF-11 (D4): what a restart would stop, counted before Restart now goes
// ahead. `main/index.ts` hands in the terminal and orchestration readers, so
// this feature imports neither feature's index.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus } from "../../../shared/orchestration";

/**
 * How many saved runs are active now.
 *
 * The run files in `dir` name every run and its project; the orchestrator,
 * through `statusOf`, says where each one is now, since a file can lag
 * behind the run it holds.
 *
 * NOTE: `dir` is the orchestrator's own `<userData>/orchestration/runs`
 * (`orchestration/index.ts`, `runtime.ts`). It has no call that counts runs
 * across projects, and only the run files list every project with one.
 */
export async function countActiveRuns(
  dir: string,
  statusOf: (project: string, runId: string) => Promise<RunStatus | null>,
): Promise<number> {
  const names = await readdir(dir).catch((): string[] => []);
  const statuses = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const record = JSON.parse(await readFile(join(dir, name), "utf8"));
          const run = record?.run;
          // A run saved before FE-107 names its project `workspace`.
          const project = run?.project ?? run?.workspace;
          if (typeof run?.id !== "string" || typeof project !== "string")
            return null;
          if (run.status !== "active" && run.status !== "paused") return null;
          return await statusOf(project, run.id);
        } catch {
          return null;
        }
      }),
  );
  return statuses.filter((status) => status === "active").length;
}
