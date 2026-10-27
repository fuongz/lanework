import { useEffect, useState } from "react";
import type { OrchestrationRun } from "#/../shared/orchestration";

const NO_RUNS: OrchestrationRun[] = [];

/** A run still holding workers: one the rail nests under its lead. */
export const liveRun = (run: OrchestrationRun) =>
  run.status === "active" || run.status === "paused";

/**
 * The project's orchestration runs (FE-87), kept current from main's events.
 *
 * The rail nests a run's workers under its lead's row, and a worker's chat
 * names its lead. A worker's own conversation lives in its worktree, so the
 * project's listing never has it.
 */
export function useOrchestrationRuns(
  workspace: string | null,
): readonly OrchestrationRun[] {
  const [runs, setRuns] = useState<readonly OrchestrationRun[]>(NO_RUNS);
  useEffect(() => {
    setRuns(NO_RUNS);
    const surface = window.desktop?.orchestration;
    if (!surface || !workspace) return;
    let gone = false;
    void surface
      .runs(workspace)
      .then((list) => {
        if (!gone) setRuns(list);
      })
      .catch(() => {});
    const off = surface.onChange((event) => {
      if (event.workspace !== workspace) return;
      setRuns((current) => {
        const at = current.findIndex((run) => run.id === event.run.id);
        if (at === -1) return [event.run, ...current];
        const next = [...current];
        next[at] = event.run;
        return next;
      });
    });
    return () => {
      gone = true;
      off();
    };
  }, [workspace]);
  return runs;
}
