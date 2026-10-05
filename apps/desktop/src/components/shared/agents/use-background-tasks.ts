import { useEffect, useState } from "react";
import type {
  BackgroundTask,
  BackgroundTaskOutput,
} from "#/../shared/terminal";
import { ipcMessage } from "#/lib/ipc-error";

/** How often a running shell's output is read again (FE-42/D3). */
const OUTPUT_POLL_MS = 1_000;
/** A conversation writing many times a second asks for its list at most this often. */
const RELIST_MS = 1_000;

/**
 * The tasks a Claude conversation started in the background (FE-42), running
 * first then newest — read again whenever `cue` changes (its listing's
 * `updatedAt` and counts) and when its own transcript is written: a task's
 * notification is a line in it.
 *
 * ⚠️ One read in flight at a time, at most one queued behind it, and writes
 * folded to one read a second: a working conversation writes many times a
 * second, and a read that started first must not land after a later one.
 */
export function useBackgroundTasks(
  workspace: string | null,
  conversation: string | null,
  cue: string,
  enabled = true,
): { tasks: BackgroundTask[] | null; error: string | null } {
  const key = `${workspace}:${conversation}`;
  const [state, setState] = useState<{
    key: string;
    tasks: BackgroundTask[] | null;
    error: string | null;
  }>({ key: "", tasks: null, error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `cue` is the cue to read again
  useEffect(() => {
    const surface = window.desktop?.terminal;
    if (!workspace || !conversation || !enabled || !surface) return;
    let gone = false;
    let reading = false;
    let again = false;
    let later: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      surface
        .agentBackgroundTasks(workspace, conversation)
        .then((tasks) => {
          if (!gone) setState({ key, tasks, error: null });
        })
        .catch((error: unknown) => {
          if (gone) return;
          // A read that failed keeps what the last one showed.
          setState((previous) => ({
            key,
            tasks: previous.key === key ? previous.tasks : null,
            error: ipcMessage(error, "Could not read its background tasks."),
          }));
        })
        .finally(() => {
          reading = false;
          if (again && !gone) {
            again = false;
            read();
          }
        });
    };
    read();
    const off = surface.onAgentActivity((activity) => {
      if (
        activity.workspace !== workspace ||
        activity.agent !== "claude" ||
        activity.id !== conversation ||
        activity.subagent ||
        later
      )
        return;
      later = setTimeout(() => {
        later = null;
        read();
      }, RELIST_MS);
    });
    return () => {
      gone = true;
      if (later) clearTimeout(later);
      off();
    };
  }, [key, workspace, conversation, enabled, cue]);

  // Another conversation's, still on screen from before: none yet.
  return state.key === key
    ? { tasks: state.tasks, error: state.error }
    : { tasks: null, error: null };
}

/**
 * The end of one background shell's output (FE-42/D5): read once, then every
 * second while it is `running` and the window is visible — a finished task's
 * file no longer grows.
 */
export function useTaskOutput(
  workspace: string | null,
  conversation: string,
  task: string,
  running: boolean,
): { output: BackgroundTaskOutput | null; error: string | null } {
  const key = `${workspace}:${conversation}/${task}`;
  const [state, setState] = useState<{
    key: string;
    output: BackgroundTaskOutput | null;
    error: string | null;
  }>({ key: "", output: null, error: null });

  useEffect(() => {
    const surface = window.desktop?.terminal;
    if (!workspace || !surface) return;
    let gone = false;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      surface
        .agentTaskOutput(workspace, conversation, task)
        .then((output) => {
          if (!gone) setState({ key, output, error: null });
        })
        .catch((error: unknown) => {
          if (gone) return;
          setState((previous) => ({
            key,
            output: previous.key === key ? previous.output : null,
            error: ipcMessage(error, "Could not read its output."),
          }));
        })
        .finally(() => {
          reading = false;
        });
    };
    // ⚠️ Once more when it stops running: its last lines came with the end.
    read();
    if (!running)
      return () => {
        gone = true;
      };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, OUTPUT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, workspace, conversation, task, running]);

  return state.key === key
    ? { output: state.output, error: state.error }
    : { output: null, error: null };
}
