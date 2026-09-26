import { useEffect } from "react";
import { create } from "zustand";
import type { TerminalAgent } from "../../shared/terminal";
import type { BoardPresence } from "../../shared/workspaces";

/**
 * How often an open board asks who is working on it (BE-16/D2a).
 *
 * ⚠️ Every poll is a billed D1 read on the service, so it only runs while the
 * window has focus — see `usePresencePoll`.
 */
const POLL_MS = 30_000;

/**
 * The agents every machine has working on the open board's cards (BE-16), as
 * the service last reported them.
 *
 * ⚠️ One board at a time, keyed by its id, because the rows are only
 * meaningful for the board they were read for: switching projects must not
 * show the last one's agents on the new one's cards for a poll.
 */
interface BoardPresenceState {
  workspaceId: string | null;
  rows: BoardPresence[];
  refresh: (workspaceId: string) => Promise<void>;
}

const NONE: BoardPresence[] = [];

/** A read that started before a later one must not land after it. */
let generation = 0;

export const useBoardPresence = create<BoardPresenceState>((set) => ({
  workspaceId: null,
  rows: NONE,
  refresh: async (workspaceId) => {
    const mine = ++generation;
    const surface = window.desktop?.workspaces;
    if (!surface) return;
    let rows: BoardPresence[];
    try {
      rows = await surface.board.presence(workspaceId);
    } catch {
      // ⚠️ Dropped, not kept. A spinner the service can no longer vouch for
      // would say an agent is working long after it stopped.
      rows = NONE;
    }
    if (mine !== generation) return;
    set({ workspaceId, rows });
  },
}));

/**
 * Keep `workspaceId`'s presence fresh while the calling screen is mounted:
 * read now, every 30s while the window has focus, and again when it regains
 * it (BE-16/D2a).
 */
export function usePresencePoll(workspaceId: string | null): void {
  const refresh = useBoardPresence((state) => state.refresh);
  useEffect(() => {
    if (!workspaceId) return;
    const read = () => void refresh(workspaceId);
    read();
    const timer = window.setInterval(() => {
      if (document.hasFocus()) read();
    }, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [refresh, workspaceId]);
}

/**
 * The terminal kind an OAuth client's slug names, or null for an agent this
 * app has no mark for. `claude-code` → `claude`.
 */
export function presenceKind(agent: string): TerminalAgent | null {
  if (agent.startsWith("claude")) return "claude";
  if (agent.startsWith("codex")) return "codex";
  return null;
}

/**
 * The presence rows on `card` that this machine's transcripts do not already
 * show (BE-16/D7).
 *
 * ⚠️ A row is this machine's own when it carries this machine's id — or, over
 * OAuth, which carries none, when it is the signed-in user's. Such a row is
 * hidden only when a local session of the SAME agent is already on the card:
 * FE-27 knows that one exactly, and the service's copy would be a second,
 * vaguer mark for the same thing.
 */
export function cloudAgentsOn(
  state: Pick<BoardPresenceState, "workspaceId" | "rows">,
  workspace: string,
  cardId: string,
  me: { userId: string | null; machineId: string | null },
  localKinds: readonly TerminalAgent[],
): BoardPresence[] {
  if (state.workspaceId !== workspace) return NONE;
  const out: BoardPresence[] = [];
  for (const row of state.rows) {
    if (row.cardId !== cardId) continue;
    const mine =
      row.machineId !== null
        ? row.machineId === me.machineId
        : row.userId === me.userId;
    const kind = presenceKind(row.agent);
    if (mine && kind && localKinds.includes(kind)) continue;
    out.push(row);
  }
  return out.length ? out : NONE;
}
