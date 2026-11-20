// One rail row per thread: sessions joined by an in-place handoff
// (`conversation.switchAgent`) are one conversation to the person. Nothing
// here imports Electron or the conversation feature: the chains come in
// through `RailThreads`, which the conversation view sets.
import type { AgentSession, TerminalAgent } from "../../../shared/terminal";

/** One session of a thread, head first. */
export interface RailThreadSession {
  conversation: string;
  agent: TerminalAgent;
}

/** What the rail needs to know of threads. */
export interface RailThreads {
  /**
   * The sessions of `id`'s thread, head first; empty when `id` is in none.
   * Answers from memory, without waiting.
   */
  chainOf: (id: string) => readonly RailThreadSession[];
}

/** `{ agents }`: each agent of `chain` once, oldest first; none for one. */
function agentsOf(chain: readonly RailThreadSession[]): {
  agents?: TerminalAgent[];
} {
  const agents = [...new Set(chain.map((session) => session.agent))];
  return agents.length > 1 ? { agents } : {};
}

/**
 * `listed` with each thread folded into its head's row.
 *
 * - A later session of a thread (a successor) is never a row of its own.
 * - The head's row takes the NEWEST session's activity: `updatedAt`,
 *   `working`, `card`, `subagents` and `background`; its own id, agent,
 *   title, pin and conductor stay. The rail then shows the thread as
 *   working while its newest session runs a turn, and dates it by that one.
 * - It stands where the first of its sessions does in `listed` (newest
 *   first): where its most recently written session does.
 *
 * NOTE: A successor is listed by the store as any session is (it is a CLI
 * conversation of the project's folder), so it is hidden here, not there:
 * a Pull or a watcher write can never bring it back as a row.
 *
 * @param listed The store's rows, newest first.
 * @param rowOf A row the store has though `listed` left it out (a head
 *   older than the rail's limit), or null.
 */
export function foldThreads(
  listed: readonly AgentSession[],
  threads: RailThreads | null,
  rowOf: (agent: TerminalAgent, id: string) => AgentSession | null,
): AgentSession[] {
  if (!threads) return [...listed];
  const byId = new Map(listed.map((row) => [row.id, row]));
  const done = new Set<string>();
  const out: AgentSession[] = [];
  for (const row of listed) {
    const chain = threads.chainOf(row.id);
    const head = chain[0];
    const newest = chain.at(-1);
    if (!head || !newest || chain.length < 2) {
      if (!done.has(row.id)) out.push(row);
      done.add(row.id);
      continue;
    }
    if (done.has(head.conversation)) continue;
    done.add(head.conversation);
    const base = byId.get(head.conversation) ??
      rowOf(head.agent, head.conversation) ?? {
        // NOTE: The head's own row is gone (deleted, or never read in):
        // the thread still lists under its id, titled by this session.
        ...row,
        id: head.conversation,
        agent: head.agent,
      };
    const last =
      byId.get(newest.conversation) ??
      rowOf(newest.agent, newest.conversation) ??
      row;
    out.push({
      ...base,
      updatedAt: last.updatedAt,
      working: last.working,
      card: last.card,
      subagents: last.subagents,
      background: last.background,
      // The rail draws every agent the thread ran on, not only the head's.
      ...agentsOf(chain),
    });
  }
  return out;
}
