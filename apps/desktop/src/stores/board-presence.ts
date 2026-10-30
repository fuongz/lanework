import { useEffect } from "react";
import { create } from "zustand";
import type { BoardPresence } from "../../shared/projects";
import type { TerminalAgent } from "../../shared/terminal";

/**
 * How often an open board asks who is working on it (BE-16/D2a).
 *
 * NOTE: Every poll is a billed D1 read on the service, so it runs only while
 * the window has focus (see {@link usePresencePoll}).
 */
const POLL_MS = 30_000;

/**
 * The agents every machine has working on the open board's cards.
 *
 * As the service last reported them.
 *
 * NOTE: One board at a time, keyed by its id. The rows mean something only
 * for the board they were read for: after a switch, the last board's agents
 * must not show on the new one's cards until the next poll.
 */
interface BoardPresenceState {
  projectId: string | null;
  rows: BoardPresence[];
  refresh: (projectId: string) => Promise<void>;
}

const NONE: BoardPresence[] = [];

/**
 * The request ticket for presence reads.
 *
 * A read that started before a later one must not land after it.
 */
let generation = 0;

export const useBoardPresence = create<BoardPresenceState>((set) => ({
  projectId: null,
  rows: NONE,
  refresh: async (projectId) => {
    const mine = ++generation;
    const surface = window.desktop?.projects;
    if (!surface) return;
    let rows: BoardPresence[];
    try {
      rows = await surface.board.presence(projectId);
    } catch {
      // NOTE: Dropped, not kept. A spinner the service can no longer vouch
      // for would say an agent is working long after it stopped.
      rows = NONE;
    }
    if (mine !== generation) return;
    set({ projectId, rows });
  },
}));

/**
 * Keep `projectId`'s presence fresh while the calling screen is mounted.
 *
 * Reads now, every {@link POLL_MS} while the window has focus, and again
 * when it regains it (BE-16/D2a).
 *
 * @param projectId The cloud project id; null polls nothing.
 */
export function usePresencePoll(projectId: string | null): void {
  const refresh = useBoardPresence((state) => state.refresh);
  useEffect(() => {
    if (!projectId) return;
    const read = () => void refresh(projectId);
    read();
    const timer = window.setInterval(() => {
      if (document.hasFocus()) read();
    }, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [refresh, projectId]);
}

/**
 * The terminal kind an OAuth client's slug names.
 *
 * @param agent The OAuth client's slug, such as `claude-code`.
 * @returns `claude-code` → `claude`. Null for an agent this app has no mark
 * for.
 */
export function presenceKind(agent: string): TerminalAgent | null {
  if (agent.startsWith("claude")) return "claude";
  if (agent.startsWith("codex")) return "codex";
  if (agent.startsWith("opencode")) return "opencode";
  return null;
}

/**
 * The presence rows on a card that this machine does not already show.
 *
 * This machine's transcripts already mark their own sessions (BE-16/D7).
 * A row is this machine's own when it carries this machine's id. Over OAuth,
 * which carries none, it is this machine's when it is the signed-in user's.
 * Such a row is hidden only when a local session of the same agent is already
 * on the card: the local session is exact, and the service's copy would be a
 * second, vaguer mark for the same thing.
 *
 * @param project The cloud project id the rows must have been read for.
 * @param localKinds The agents this machine's own sessions on the card run.
 * @returns A stable empty list when there are none.
 */
export function cloudAgentsOn(
  state: Pick<BoardPresenceState, "projectId" | "rows">,
  project: string,
  cardId: string,
  me: { userId: string | null; machineId: string | null },
  localKinds: readonly TerminalAgent[],
): BoardPresence[] {
  if (state.projectId !== project) return NONE;
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
