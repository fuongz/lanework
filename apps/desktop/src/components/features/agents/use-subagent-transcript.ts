import { useEffect, useState } from "react";
import type { SubagentTranscript, TerminalAgent } from "#/../shared/terminal";
import { ipcMessage } from "#/lib/ipc-error";

/**
 * One sub-agent's transcript, as main last read it.
 *
 * Read again each time the watcher says THAT sub-agent was written
 * (FE-35/D11). Never on a timer: a done one is never written, so it is read
 * once.
 *
 * NOTE: one read in flight at a time, and at most one queued behind it: a
 * working sub-agent writes many times a second, and a read that started
 * first must not land after a later one.
 */
export function useSubagentTranscript(
  workspace: string | null,
  agent: TerminalAgent,
  conversation: string,
  sub: string,
): { transcript: SubagentTranscript | null; error: string | null } {
  const key = `${workspace}:${agent}:${conversation}/${sub}`;
  const [state, setState] = useState<{
    key: string;
    transcript: SubagentTranscript | null;
    error: string | null;
  }>({ key: "", transcript: null, error: null });

  useEffect(() => {
    const surface = window.desktop?.terminal;
    if (!workspace || !surface) return;
    let gone = false;
    let reading = false;
    let again = false;
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      surface
        .agentSubagent(workspace, agent, conversation, sub)
        .then((transcript) => {
          if (!gone) setState({ key, transcript, error: null });
        })
        .catch((error: unknown) => {
          if (gone) return;
          // A read that failed mid-run keeps what the last one showed.
          setState((previous) => ({
            key,
            transcript: previous.key === key ? previous.transcript : null,
            error: ipcMessage(error, "Could not read this sub-agent."),
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
        activity.workspace === workspace &&
        activity.agent === agent &&
        activity.id === conversation &&
        activity.subagent === sub
      )
        read();
    });
    return () => {
      gone = true;
      off();
    };
  }, [key, workspace, agent, conversation, sub]);

  // Another sub-agent's, still on screen from before: none yet.
  return state.key === key
    ? { transcript: state.transcript, error: state.error }
    : { transcript: null, error: null };
}
